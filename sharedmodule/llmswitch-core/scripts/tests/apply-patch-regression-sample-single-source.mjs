#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const projectRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
  '..',
);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'llms-apply-patch-reg-'));
  process.env.ROUTECODEX_ERRORSAMPLES_DIR = path.join(tmpRoot, 'apply_patch');

  const { validateToolCall } = await import(
    path.join(projectRoot, 'dist', 'tools', 'tool-registry.js')
  );
  const { captureApplyPatchRegression } = await import(
    path.join(projectRoot, 'dist', 'tools', 'apply-patch', 'regression-capturer.js')
  );

  const invalidArgs = JSON.stringify({ patch: 'not a patch' });
  const validation = validateToolCall('apply_patch', invalidArgs);
  assert.equal(validation.ok, false, 'tool-registry path must stay invalid for non-patch payload');
  captureApplyPatchRegression({
    errorType: validation.reason || 'invalid_apply_patch_args',
    originalArgs: invalidArgs,
    normalizedArgs: invalidArgs,
    validationError: validation.reason || 'invalid_apply_patch_args',
    source: 'tool-registry.validateToolCall'
  });
  await sleep(50);

  const root = path.join(tmpRoot, 'apply_patch');
  const sampleFiles = [];
  if (fs.existsSync(root)) {
    for (const typeDir of fs.readdirSync(root)) {
      const dir = path.join(root, typeDir);
      for (const entry of fs.readdirSync(dir)) {
        if (entry.endsWith('.json')) {
          sampleFiles.push(path.join(dir, entry));
        }
      }
    }
  }

  assert.ok(sampleFiles.length >= 1, 'expected at least one explicit apply_patch regression sample');

  const samples = sampleFiles.map((file) => JSON.parse(fs.readFileSync(file, 'utf8')));
  const registrySample = samples.find((sample) => sample.source === 'tool-registry.validateToolCall');
  assert.ok(registrySample, 'missing tool-registry regression sample');
  assert.equal(
    Object.prototype.hasOwnProperty.call(registrySample.meta ?? {}, 'applyPatchToolMode'),
    false,
    'tool-registry regression sample must not invent applyPatchToolMode'
  );

  const toolGovernorDist = fs.readFileSync(
    path.join(projectRoot, 'dist', 'conversion', 'shared', 'tool-governor.js'),
    'utf8'
  );
  assert.equal(
    toolGovernorDist.includes("meta: { applyPatchToolMode: 'freeform' }"),
    false,
    'tool-governor dist must not hardcode applyPatchToolMode freeform meta'
  );
  assert.equal(
    toolGovernorDist.includes('meta:{applyPatchToolMode:"freeform"}'),
    false,
    'tool-governor dist must not hardcode minified applyPatchToolMode freeform meta'
  );

  captureApplyPatchRegression({
    errorType: 'invalid_patch',
    originalArgs: invalidArgs,
    normalizedArgs: invalidArgs,
    validationError: 'invalid_patch',
    source: 'cross-source.a'
  });
  captureApplyPatchRegression({
    errorType: 'invalid_patch',
    originalArgs: invalidArgs,
    normalizedArgs: invalidArgs,
    validationError: 'invalid_patch',
    source: 'cross-source.b'
  });
  await sleep(50);

  const regressionDir = path.join(root, 'apply-patch-regression');
  const regressionSamples = fs
    .readdirSync(regressionDir)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => JSON.parse(fs.readFileSync(path.join(regressionDir, entry), 'utf8')));
  const crossSourceSamples = regressionSamples.filter((sample) => String(sample.source).startsWith('cross-source.'));
  assert.equal(
    crossSourceSamples.length,
    2,
    'apply_patch regression dedupe must keep separate samples for distinct sources'
  );

  console.log('✅ apply_patch regression sample single-source passed');
}

main().catch((error) => {
  console.error('❌ apply_patch regression sample single-source failed:', error);
  process.exit(1);
});
