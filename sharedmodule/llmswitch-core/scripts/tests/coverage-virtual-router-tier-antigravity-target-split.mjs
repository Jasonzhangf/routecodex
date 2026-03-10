#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const moduleUrl = pathToFileURL(
  path.join(
    repoRoot,
    'dist',
    'router',
    'virtual-router',
    'engine-selection',
    'tier-selection-antigravity-target-split.js'
  )
).href;

async function importFresh(tag) {
  return import(`${moduleUrl}?case=${tag}_${Date.now()}_${Math.random().toString(16).slice(2)}`);
}

async function main() {
  const mod = await importFresh('tier-antigravity-target-split');
  const shouldAvoidAllAntigravityOnRetry = mod.shouldAvoidAllAntigravityOnRetry;
  const shouldAvoidAntigravityAfterRepeatedError = mod.shouldAvoidAntigravityAfterRepeatedError;
  const preferNonAntigravityWhenPossible = mod.preferNonAntigravityWhenPossible;
  const extractNonAntigravityTargets = mod.extractNonAntigravityTargets;

  assert.equal(typeof shouldAvoidAllAntigravityOnRetry, 'function');
  assert.equal(typeof shouldAvoidAntigravityAfterRepeatedError, 'function');
  assert.equal(typeof preferNonAntigravityWhenPossible, 'function');
  assert.equal(typeof extractNonAntigravityTargets, 'function');

  {
    assert.equal(shouldAvoidAllAntigravityOnRetry(undefined), false);
    assert.equal(shouldAvoidAllAntigravityOnRetry(null), false);
    assert.equal(shouldAvoidAllAntigravityOnRetry([]), false);
    assert.equal(shouldAvoidAllAntigravityOnRetry({ __rt: true }), false);
    assert.equal(shouldAvoidAllAntigravityOnRetry({ __rt: [] }), false);
    assert.equal(shouldAvoidAllAntigravityOnRetry({ __rt: {} }), false);
    assert.equal(shouldAvoidAllAntigravityOnRetry({ __rt: { antigravityAvoidAllOnRetry: true } }), true);
  }

  {
    assert.equal(shouldAvoidAntigravityAfterRepeatedError(undefined), false);
    assert.equal(shouldAvoidAntigravityAfterRepeatedError({ __rt: true }), false);
    assert.equal(shouldAvoidAntigravityAfterRepeatedError({ __rt: [] }), false);
    assert.equal(shouldAvoidAntigravityAfterRepeatedError({ __rt: { antigravityAvoidAllOnRetry: true } }), true);
    assert.equal(
      shouldAvoidAntigravityAfterRepeatedError({
        __rt: { antigravityRetryErrorSignature: 'timeout', antigravityRetryErrorConsecutive: 2.8 }
      }),
      true
    );
    assert.equal(
      shouldAvoidAntigravityAfterRepeatedError({
        __rt: { antigravityRetryErrorSignature: 'unknown', antigravityRetryErrorConsecutive: 99 }
      }),
      false
    );
    assert.equal(
      shouldAvoidAntigravityAfterRepeatedError({
        __rt: { antigravityRetryErrorSignature: 'timeout', antigravityRetryErrorConsecutive: 1 }
      }),
      false
    );
    assert.equal(
      shouldAvoidAntigravityAfterRepeatedError({
        __rt: { antigravityRetryErrorSignature: '   ', antigravityRetryErrorConsecutive: 9 }
      }),
      false
    );
    assert.equal(
      shouldAvoidAntigravityAfterRepeatedError({
        __rt: { antigravityRetryErrorSignature: 'timeout', antigravityRetryErrorConsecutive: Number.NaN }
      }),
      false
    );
    assert.equal(
      shouldAvoidAntigravityAfterRepeatedError({
        __rt: { antigravityRetryErrorSignature: 404, antigravityRetryErrorConsecutive: 7 }
      }),
      false
    );
  }

  {
    const one = ['antigravity.a.gemini-3'];
    assert.deepEqual(preferNonAntigravityWhenPossible(undefined), undefined);
    assert.equal(preferNonAntigravityWhenPossible(one), one);
    assert.deepEqual(preferNonAntigravityWhenPossible([]), []);
    assert.deepEqual(
      preferNonAntigravityWhenPossible(['antigravity.a.gemini-3', 'tab.key1.gpt-5']),
      ['tab.key1.gpt-5']
    );
    assert.deepEqual(
      preferNonAntigravityWhenPossible(['tab.key1.gpt-5', 'tab.key2.gpt-5']),
      ['tab.key1.gpt-5', 'tab.key2.gpt-5']
    );
    assert.deepEqual(
      preferNonAntigravityWhenPossible(['antigravity.a.gemini-3', 'antigravity.b.gemini-3']),
      ['antigravity.a.gemini-3', 'antigravity.b.gemini-3']
    );
  }

  {
    assert.deepEqual(extractNonAntigravityTargets(undefined), []);
    assert.deepEqual(extractNonAntigravityTargets([]), []);
    assert.deepEqual(extractNonAntigravityTargets(['antigravity.a.gemini-3']), []);
    assert.deepEqual(
      extractNonAntigravityTargets(['antigravity.a.gemini-3', 'tab.key1.gpt-5', 'mock.key1.gpt-test']),
      ['tab.key1.gpt-5', 'mock.key1.gpt-test']
    );
  }

  console.log('✅ coverage-virtual-router-tier-antigravity-target-split passed');
}

main().catch((error) => {
  console.error('❌ coverage-virtual-router-tier-antigravity-target-split failed:', error);
  process.exit(1);
});
