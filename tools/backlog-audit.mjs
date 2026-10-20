#!/usr/bin/env node
/**
 * tools/backlog-audit.mjs — which backlog entries are actually open.
 *
 * WRITTEN BECAUSE A GREP OVER-REPORTED BY 3x. docs/BACKLOG.md's convention, introduced by its own
 * AUDIT section, is that a resolved entry's heading carries its status (FIXED / CLOSED / MEASURED
 * / REFUSED / SHIPPED / a priced refusal) and the ORIGINAL entry is kept verbatim underneath a
 * `#### ` marker. `grep '^### #'` therefore counts every preserved record as an open item: it
 * returns 17 where the answer is 4, and two of those 17 were records sitting one line under their
 * own marker. A round reading that list re-audits entries that were closed in the same session.
 *
 * So the rule the file states — "a heading carries its status" — needs the reader to know which
 * headings are LIVE, and that is a property of the marker above them rather than of the heading.
 *
 * `--selftest` runs it against hand-built input where the answer is known, including the two cases
 * the naive grep gets wrong: a record under a marker, and a live heading after the marker's section
 * has ended at the next `## `.
 */
import fs from 'node:fs';

const SELFTEST = process.argv.includes('--selftest');
const IS_MAIN = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());

/**
 * A `#### ` line that announces a preserved copy of an older entry. A LIST of the phrases the file
 * uses, and the file's phrasing grew past it: `#### #139 (as filed)` and `#### THE BLOCKED RECORD`
 * (#64) were read as nothing, so their verbatim records -- headed OPEN and STILL BLOCKED, as filed --
 * counted as two of eleven open entries where both were closed. "(as filed)" on the MARKER is the
 * form 2026-10-19's entries use; the record under it keeps its original heading word for word.
 */
const PRESERVED = /^#### .*(original record|kept verbatim|the round that measured|\(as filed\)|blocked record)/i;
/** A status word in a live heading. `(original record)` is self-labelling and counts too. */
const RESOLVED = /FIXED|CLOSED|MEASURED|REFUSED|PRICED|SHIPPED|NARROWED|working as designed|\((the )?original record\)|\(as filed\)|\(the investigation that got there\)/i;

export function audit(text) {
  const live = [];
  let preserved = false, skipped = 0;
  text.split('\n').forEach((L, i) => {
    if (L.startsWith('#### ')) { preserved = PRESERVED.test(L); return; }
    // A new top-level section ends whatever preserved block we were in.
    if (L.startsWith('## ')) { preserved = false; return; }
    const m = /^### (#\d+)\b(.*)/.exec(L);
    /**
     * A MARKER PRESERVES THE HEADING DIRECTLY UNDER IT, OR NOTHING. Some records keep their heading
     * (`#### #139 (as filed)` then `### #139 OPEN — ...`) and some are body text only (`#### #133
     * (as filed)` then "From the driver's re-review..."). For the second shape the flag used to
     * stay up until the next `### #`, which is the next LIVE entry: teaching this list "(as filed)"
     * first skipped #131, #134 and #135, all FIXED, along with the two records it was meant to find.
     */
    if (!m) { if (preserved && L.trim()) preserved = false; return; }
    /**
     * A MARKER PRESERVES ONE RECORD, NOT THE REST OF THE SECTION. The first version left
     * `preserved` on until the next `####` or `##` line, so every live entry written after a
     * record in the same section was skipped too — 22 of them, #48 and #113 among them, and #54
     * and #36, which carry no status at all and were therefore open and invisible. The file's
     * convention is one `### #N` record under each marker, so the marker is consumed by it.
     */
    if (preserved) { skipped++; preserved = false; return; }
    live.push({ line: i + 1, id: m[1], rest: m[2].trim(), open: !RESOLVED.test(m[2]) });
  });
  return { live, skipped, open: live.filter((h) => h.open) };
}

if (SELFTEST && IS_MAIN) {
  console.log('BACKLOG AUDIT SELFTEST\n');
  let pass = 0, fail = 0;
  const check = (n, ok, d = '') => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${n}${d ? ' — ' + d : ''}`); ok ? pass++ : fail++; };

  const fixture = [
    '## Section one',
    '### #1 FIXED — done and gated',
    'body',
    '#### THE ORIGINAL RECORD',
    // Preserved, and carrying NO status word — which is what the real records look like, because
    // they are verbatim copies of entries written before the convention existed. A fixture whose
    // record said "(as filed)" does NOT contain the trap: the status regex matches it and the
    // naive grep gets the right answer by luck. The known-bad check below caught exactly that.
    '### #1 the thing as reported',              // preserved: must NOT count
    'body',
    '## Section two',
    '### #2 still a real problem',               // live AND open: the one answer
    'body',
    '#### Some other subheading',                // not a preserved marker
    '### #3 SHIPPED — landed',
    '#### THE ORIGINAL RECORD',
    '### #4 the record of #3',                   // preserved: must NOT count
    'body',
    // AND THE ENTRY AFTER A RECORD IN THE SAME SECTION IS LIVE. The first version of the scope
    // skipped it, and that is the shape the real file has everywhere: a restated entry, its
    // record, then the next entry.
    '### #5 open and written after a record',    // live AND open
  ].join('\n');
  const a = audit(fixture);
  check('a record under a preserved marker is not counted', a.skipped === 2, `${a.skipped} skipped`);
  check('and the live headings are the other four', a.live.length === 4,
    a.live.map((h) => h.id).join(','));
  check('exactly two of them read open', a.open.length === 2 && a.open[0].id === '#2'
    && a.open[1].id === '#5', a.open.map((h) => h.id).join(',') || 'none');
  check('KNOWN-BAD: the entry written after a record in the same section is LIVE — the first ' +
    'scope skipped it, and so skipped #48', a.live.some((h) => h.id === '#5'),
    a.live.map((h) => h.id).join(','));
  /**
   * THE KNOWN-BAD: the naive grep. It counts every `### #` line, so on this fixture it reports 4
   * headings and 2 without a status — which is the over-report this tool exists to fix, in
   * miniature. Asserted so the fixture is proved to contain the trap rather than assumed to.
   */
  const naive = fixture.split('\n').filter((L) => /^### #\d/.test(L));
  const naiveOpen = naive.filter((L) => !RESOLVED.test(L));
  check('the fixture does contain the trap: a naive grep reads 6 headings and 4 open',
    naive.length === 6 && naiveOpen.length === 4,
    `${naive.length} headings / ${naiveOpen.length} open, against this tool's `
    + `${a.live.length} / ${a.open.length}`);
  /**
   * THE MARKER FORMS THE FILE GREW INTO. `#### #N (as filed)` over a verbatim `### #N OPEN — ...`,
   * and `#### THE BLOCKED RECORD` over a `### #N ... STILL BLOCKED`: both records must be skipped and
   * the live entry after each must still count. The phrase list missed both until 2026-10-20.
   */
  const c = audit(['### #7 MEASURED — closed', '#### #7 (as filed)', '### #7 OPEN — as reported',
    '### #8 FIXED — done', '#### THE BLOCKED RECORD', '### #8 STILL BLOCKED, on a decision',
    '### #11 a live one after both'].join('\n'));
  check('a `#### #N (as filed)` marker and a `#### THE BLOCKED RECORD` marker each preserve their record',
    c.skipped === 2 && c.open.length === 1 && c.open[0].id === '#11',
    `skipped ${c.skipped}, open ${c.open.map((h) => h.id).join(',') || 'none'}`);
  /** And a marker whose record has NO heading preserves nothing: the entry after it is live. */
  const d = audit(['#### #12 (as filed)', 'From the review, the record as body text only.', '',
    '### #13 FIXED — the next live entry', '### #14 open'].join('\n'));
  check('KNOWN-BAD: a marker over a record with no heading does not swallow the next live entry',
    d.skipped === 0 && d.live.length === 2 && d.open.length === 1 && d.open[0].id === '#14',
    `skipped ${d.skipped}, live ${d.live.map((h) => h.id).join(',')}`);
  /** A `## ` ends a preserved block, so a heading after one is live again. */
  const b = audit(['#### THE ORIGINAL RECORD', '### #9 old', '## New section', '### #10 new'].join('\n'));
  check('a new top-level section ends the preserved block',
    b.skipped === 1 && b.live.length === 1 && b.live[0].id === '#10',
    `skipped ${b.skipped}, live ${b.live.map((h) => h.id).join(',')}`);

  console.log(`\nBACKLOG AUDIT SELFTEST: ${fail ? 'FAIL' : 'PASS'} — ${pass + fail} checks, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

if (!SELFTEST && IS_MAIN) {
  const path = new URL('../docs/BACKLOG.md', import.meta.url);
  const r = audit(fs.readFileSync(path, 'utf8'));
  console.log(`BACKLOG: ${r.live.length} live headings, ${r.skipped} preserved records skipped, `
    + `${r.open.length} without a resolved status\n`);
  for (const h of r.open) console.log(`  ${h.id.padEnd(6)} line ${String(h.line).padStart(5)}  ${h.rest.slice(0, 92)}`);
  if (!r.open.length) console.log('  (none)');
  /**
   * THE NAIVE COUNT, printed because it is the number this tool exists to replace. Quote the OPEN
   * figure rather than the heading figure: 56 headings is obviously a listing of everything, where
   * a filtered 17 reads like an answer. That is what sent a round re-auditing closed entries.
   */
  const all = fs.readFileSync(path, 'utf8').split('\n').filter((L) => /^### #\d/.test(L));
  const naiveOpen = all.filter((L) => !RESOLVED.test(L.replace(/^### /, '').replace(/^#\d+\b/, '')));
  console.log(`\nA naive \`grep '^### #'\` reads ${all.length} headings here, `
    + `${naiveOpen.length} of them without a status — against ${r.open.length} actually open.`);
}
