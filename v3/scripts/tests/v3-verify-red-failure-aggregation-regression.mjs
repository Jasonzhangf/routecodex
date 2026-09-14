#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const v3Root = resolve(new URL('../..', import.meta.url).pathname);
const verifyRedPath = join(v3Root, 'scripts', 'verify-red.mjs');
const commonPath = join(v3Root, 'scripts', '_common.mjs');
const source = readFileSync(verifyRedPath, 'utf8').replace(
  "from './_common.mjs'",
  `from ${JSON.stringify(commonPath)}`,
);
assert.match(source, /import \{ runAll \} from/u, 'verify-red must use the shared bounded collector');
assert.doesNotMatch(source, /for \(const fixture of \[/u, 'verify-red must not launch unawaited fixture runs');
assert.match(source, /await runAll\(entries\)/u, 'verify-red must await matrix completion');

const fixtureRoot = mkdtempSync(join(tmpdir(), 'routecodex-v3-verify-red-aggregation-'));
try {
  const entriesStart = source.indexOf('const entries = [');
  const entriesEnd = source.indexOf('\n\nconst { failures', entriesStart);
  assert(entriesStart >= 0 && entriesEnd > entriesStart, 'controlled fixture must locate entries');
  const controlledEntries = `const entries = [
  { label: 'first-independent-failure', command: 'node', args: ['-e', "console.error('FIRST_INDEPENDENT_FAILURE'); process.exit(11)"], severity: 'BLOCK' },
  { label: 'second-independent-failure', command: 'node', args: ['-e', "console.error('SECOND_INDEPENDENT_FAILURE'); process.exit(12)"], severity: 'BLOCK' },
  { label: 'after-independent-failures', command: 'node', args: ['-e', "console.log('AFTER_INDEPENDENT_FAILURES')"], severity: 'BLOCK' },
];`;
  writeFileSync(
    join(fixtureRoot, 'verify-red.mjs'),
    source.slice(0, entriesStart) + controlledEntries + source.slice(entriesEnd),
  );
  const result = spawnSync(process.execPath, [join(fixtureRoot, 'verify-red.mjs')], {
    cwd: fixtureRoot,
    encoding: 'utf8',
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  assert.notEqual(result.status, 0, 'independent red failures must fail the matrix');
  assert.match(output, /FIRST_INDEPENDENT_FAILURE/);
  assert.match(output, /SECOND_INDEPENDENT_FAILURE/);
  assert.match(output, /AFTER_INDEPENDENT_FAILURES/);
  assert.match(output, /\[v3 verify:red\] FAIL 2 gate\(s\)/);
  assert.doesNotMatch(output, /\[v3 verify:red\] PASS/);
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}

process.stdout.write('[test:v3-verify-red-failure-aggregation-regression] PASS\n');
