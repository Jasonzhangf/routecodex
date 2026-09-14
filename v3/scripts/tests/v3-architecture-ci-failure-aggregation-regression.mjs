#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const gateSource = readFileSync(
  join(repoRoot, 'v3/scripts/architecture/verify-v3-architecture-ci.mjs'),
  'utf8',
);
const stepsStart = gateSource.indexOf('const STEPS = [');
const stepsEnd = gateSource.indexOf('\n\nconst failures', stepsStart);
assert(stepsStart >= 0 && stepsEnd > stepsStart, 'controlled fixture must locate STEPS');

const controlledSteps = `const STEPS = [
  ['fixture-first-failure', 'first independent controlled failure'],
  ['fixture-second-failure', 'second independent controlled failure'],
  ['fixture-after-failures', 'independent step after failures'],
];`;
const fixtureRoot = mkdtempSync(join(tmpdir(), 'routecodex-v3-architecture-ci-aggregation-'));

try {
  writeFileSync(
    join(fixtureRoot, 'package.json'),
    JSON.stringify({
      type: 'module',
      scripts: {
        'fixture-first-failure': "node -e \"console.error('FIRST_CONTROLLED_FAILURE'); process.exit(11)\"",
        'fixture-second-failure': "node -e \"console.error('SECOND_CONTROLLED_FAILURE'); process.exit(12)\"",
        'fixture-after-failures': "node -e \"console.log('AFTER_CONTROLLED_FAILURES')\"",
      },
    }),
  );
  writeFileSync(
    join(fixtureRoot, 'verify-v3-architecture-ci.mjs'),
    gateSource.slice(0, stepsStart) + controlledSteps + gateSource.slice(stepsEnd),
  );

  const result = spawnSync(process.execPath, [join(fixtureRoot, 'verify-v3-architecture-ci.mjs')], {
    cwd: fixtureRoot,
    encoding: 'utf8',
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  assert.notEqual(result.status, 0, 'two controlled failures must fail the umbrella');
  assert.match(output, /FIRST_CONTROLLED_FAILURE/);
  assert.match(output, /SECOND_CONTROLLED_FAILURE/);
  assert.match(output, /AFTER_CONTROLLED_FAILURES/);
  assert.match(output, /FAILED at fixture-first-failure \(2 sub-failure total in run\)/);
  assert.match(output, /failed sub-gates: fixture-first-failure, fixture-second-failure/);
  assert.match(output, /passed sub-gates: 1\/3/);
  assert.ok(
    output.indexOf('fixture-first-failure') < output.indexOf('fixture-second-failure'),
    'failures must retain STEPS order',
  );
  assert.ok(
    output.indexOf('FIRST_CONTROLLED_FAILURE') < output.indexOf('SECOND_CONTROLLED_FAILURE'),
    'failure text must retain execution order',
  );
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}

process.stdout.write('[test:v3-architecture-ci-failure-aggregation-regression] PASS\n');
