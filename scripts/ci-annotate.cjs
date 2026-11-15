#!/usr/bin/env node
// Turns the failures in a `node --test` log into GitHub Actions error annotations, so a failed CI run says which
// tests failed and why without opening the log. Usage: node scripts/ci-annotate.cjs <log file>
const fs = require('node:fs');

const text = fs.readFileSync(process.argv[2], 'utf8');
const lines = text.split(/\r?\n/);
const escape = (s) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const failures = [];
for (let i = 0; i < lines.length; i++) {
  const m = /^(\s*)not ok \d+ - (.*)$/.exec(lines[i]);
  if (!m) continue;
  // The YAML block under the line carries the error; a file-level "not ok" only repeats its subtests.
  const block = [];
  for (let j = i + 1; j < lines.length && /^\s+/.test(lines[j]) && !/^\s*(not )?ok \d+ - /.test(lines[j]); j++) block.push(lines[j].replace(/^\s{0,6}/, ''));
  const detail = block.join('\n');
  if (/failureType: 'subtestsFailed'/.test(detail)) continue;
  failures.push({ name: m[2], detail: detail.split('\n').filter((l) => !/^(---|\.\.\.|duration_ms:|type:)/.test(l.trim())).slice(0, 25).join('\n') });
}
// GitHub keeps ten error annotations per step.
for (const f of failures.slice(0, 9)) console.log(`::error title=${escape(f.name).slice(0, 200)}::${escape(f.detail).slice(0, 3500)}`);
if (failures.length > 9) console.log(`::error title=${failures.length} tests failed::${escape(failures.slice(9).map((f) => f.name).join('\n')).slice(0, 3500)}`);
if (!failures.length) console.log(`::error title=Tests failed::${escape(lines.slice(-40).join('\n')).slice(0, 3500)}`);
