#!/usr/bin/env node

import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const projectRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
  '..',
);

function runRg(pattern) {
  try {
    const stdout = execFileSync(
      'rg',
      [
        '-n',
        pattern,
        'src',
        'scripts',
        'tests',
        '-g',
        '!**/dist/**'
      ],
      {
        cwd: projectRoot,
        encoding: 'utf8'
      }
    );
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (error) {
    const stdout = error && typeof error.stdout === 'string' ? error.stdout : '';
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  }
}

function assertAllowedOnly(lines, allowedPrefixes, message) {
  const violations = lines.filter((line) =>
    !line.startsWith('scripts/tests/legacy-reference-boundary.mjs:') &&
    !allowedPrefixes.some((prefix) => line.startsWith(prefix))
  );
  assert.deepEqual(violations, [], message + '\n' + violations.join('\n'));
}

async function main() {
  const archiveJsRefs = runRg(
    'chat-mapper\\.archive\\.js|archive/engine\\.legacy\\.js|archive/chat-request-filters\\.legacy\\.js'
  );
  assertAllowedOnly(
    archiveJsRefs,
    [
      'scripts/tests/archive-import-guard.mjs:',
      'scripts/tests/semantic-mapper-chat-native-compare.mjs:'
    ],
    'Only approved scripts may import archive runtime modules'
  );

  const engineLegacyJsRefs = runRg('engine-legacy\\.js');
  assertAllowedOnly(
    engineLegacyJsRefs,
    [
      'src/router/virtual-router/engine-legacy/config.ts:',
      'src/router/virtual-router/engine-legacy/health.ts:',
      'src/router/virtual-router/engine-legacy/state-accessors.ts:',
      'src/router/virtual-router/engine-legacy/selection-core.ts:',
      'src/router/virtual-router/engine-legacy/direct-model.ts:',
      'src/router/virtual-router/engine-legacy/route-utils.ts:',
      'src/router/virtual-router/engine-legacy/selection-state.ts:',
      'scripts/tests/engine-legacy-import-guard.mjs:',
      'scripts/tests/engine-legacy-compat-warning.mjs:'
    ],
    'Only approved internal legacy modules and guard scripts may reference engine-legacy.js'
  );

  console.log('✅ legacy reference boundary regression passed');
}

main().catch((error) => {
  console.error('❌ legacy reference boundary regression failed:', error);
  process.exit(1);
});
