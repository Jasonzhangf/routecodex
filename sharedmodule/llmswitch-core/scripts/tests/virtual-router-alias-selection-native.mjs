#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

function importFresh(relPath, tag) {
  const moduleUrl = pathToFileURL(path.join(repoRoot, 'dist', relPath)).href;
  return import(`${moduleUrl}?case=${tag}_${Date.now()}_${Math.random().toString(16).slice(2)}`);
}

function aliasOfKey(key) {
  const parts = String(key || '').split('.');
  const alias = parts[1] || '';
  return alias.replace(/^\d+-/, '') || null;
}

function modelIdOfKey() {
  return 'gemini-3-pro-high';
}

async function main() {
  const mod = await importFresh('router/virtual-router/engine-selection/alias-selection.js', 'alias-selection');

  assert.equal(mod.resolveAliasSelectionStrategy('antigravity', undefined), 'sticky-queue');
  assert.equal(mod.resolveAliasSelectionStrategy('antigravity', { enabled: false }), 'none');
  assert.equal(
    mod.resolveAliasSelectionStrategy('antigravity', { enabled: true, providers: { antigravity: 'none' } }),
    'none'
  );

  const queueStore = new Map();
  const candidates = [
    'antigravity.1-alpha.gemini-3-pro-high',
    'antigravity.2-beta.gemini-3-pro-high'
  ];

  const selected1 = mod.pinCandidatesByAliasQueue({
    queueStore,
    providerId: 'antigravity',
    modelId: 'gemini-3-pro-high',
    candidates,
    orderedTargets: [...candidates],
    excludedProviderKeys: new Set(),
    aliasOfKey,
    modelIdOfKey,
    availabilityCheck: () => true
  });
  assert.deepEqual(selected1, ['antigravity.1-alpha.gemini-3-pro-high']);

  const selected2 = mod.pinCandidatesByAliasQueue({
    queueStore,
    providerId: 'antigravity',
    modelId: 'gemini-3-pro-high',
    candidates,
    orderedTargets: [...candidates],
    excludedProviderKeys: new Set(['antigravity.1-alpha.gemini-3-pro-high']),
    aliasOfKey,
    modelIdOfKey,
    availabilityCheck: () => true
  });
  assert.deepEqual(selected2, ['antigravity.2-beta.gemini-3-pro-high']);

  const selected3 = mod.pinCandidatesByAliasQueue({
    queueStore,
    providerId: 'antigravity',
    modelId: 'gemini-3-pro-high',
    candidates,
    orderedTargets: [...candidates],
    excludedProviderKeys: new Set(),
    aliasOfKey,
    modelIdOfKey,
    availabilityCheck: (key) => key.includes('2-beta')
  });
  assert.deepEqual(selected3, ['antigravity.2-beta.gemini-3-pro-high']);

  console.log('✅ virtual-router-alias-selection-native passed');
}

main().catch((error) => {
  console.error('❌ virtual-router-alias-selection-native failed:', error);
  process.exit(1);
});
