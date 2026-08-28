#!/usr/bin/env node
/**
 * What has been approved here, and by what route.
 *
 * The per-session reports answer "what happened in this run". Nobody auditing an approval gate asks
 * that. They ask "what did we let through", across every run, and until now nothing could answer it
 * - the reports counted refusals and never approvals, which is backwards for a system whose entire
 * argument is the gate.
 *
 * This reads `evidence/approvals.jsonl` and, more importantly, **exits non-zero if the gate's core
 * promise was ever broken**: a pipe may refuse and may never approve. `decideApproval` enforces
 * that at the moment of the decision. This checks the record afterwards, from the other side, which
 * is the only way to catch the day somebody changes that function and every unit test still passes.
 */

import { LEDGER, read, summarise } from './lib/ledger.mjs';

const entries = read(LEDGER);

if (entries.length === 0) {
  console.log(`\n  Nothing recorded yet. ${LEDGER} fills as approvals are decided.\n`);
  process.exit(0);
}

const s = summarise(entries);

console.log();
console.log(`  ${s.total} decision(s) recorded  -  ${s.allowed} allowed, ${s.denied} denied`);
if (s.unreadable) {
  // A gap in an audit file is itself worth seeing, so it is counted rather than skipped.
  console.log(`  ${s.unreadable} line(s) could not be read`);
}
console.log();

const width = Math.max(4, ...s.tools.map((t) => t.tool.length));
for (const tool of s.tools) {
  console.log(`    ${tool.tool.padEnd(width)}   ${String(tool.allowed).padStart(3)} allowed   ${String(tool.denied).padStart(3)} denied`);
}

if (s.approvedWithoutATerminal.length > 0) {
  console.log();
  console.log('  A pipe may refuse and may never approve. These were approved another way:');
  for (const entry of s.approvedWithoutATerminal) {
    console.log(`    ${entry.at}  ${entry.tool ?? '(unnamed)'}  by ${entry.by}  session ${entry.session ?? '?'}`);
  }
  console.log();
  console.log('  That is the one invariant this project makes. Do not ship until it is explained.');
  console.log();
  process.exit(1);
}

console.log();
console.log('  Every approval came from a person at a terminal.');
console.log();
