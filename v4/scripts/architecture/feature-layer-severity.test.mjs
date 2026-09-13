import assert from 'node:assert/strict';
import test from 'node:test';
import { addFailure, severityForCode } from './lib/feature-layer-batch-contract.mjs';

test('unlisted gate failures remain fatal', () => {
  const failures = [];
  addFailure(failures, 'SOURCE_BUILD_FAILURE', 'compile failed');
  assert.deepEqual(failures, [{ code: 'SOURCE_BUILD_FAILURE', message: 'compile failed', severity: 'fatal' }]);
});

test('explicit advisory findings are warnings', () => {
  const failures = [];
  addFailure(failures, 'MIGRATION_HISTORY_WARNING', 'old migration retained');
  assert.equal(severityForCode('MIGRATION_HISTORY_WARNING'), 'warning');
  assert.equal(failures[0].severity, 'warning');
});
