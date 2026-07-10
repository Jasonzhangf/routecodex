#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

function importFresh(relPath, tag) {
  const moduleUrl = pathToFileURL(path.join(repoRoot, relPath)).href;
  return import(`${moduleUrl}?case=${tag}_${Date.now()}_${Math.random().toString(16).slice(2)}`);
}

async function main() {
  const { loadNativeRouterHotpathBinding } = await importFresh(
    'scripts/helpers/native-router-hotpath-loader.mjs',
    'loader'
  );
  const binding = loadNativeRouterHotpathBinding();
  const parseProviderKey = binding?.parseVirtualRouterHitProviderKeyJson;
  assert.equal(typeof parseProviderKey, 'function');

  const nativeParsed = JSON.parse(parseProviderKey('iflow.3-138.kimi-k2.5'));
  assert.equal(nativeParsed.providerId, 'iflow');
  assert.equal(nativeParsed.keyAlias, '3-138');
  assert.equal(nativeParsed.modelId, 'kimi-k2.5');

  const prefixedAlias = JSON.parse(parseProviderKey('openai.3-main.gpt-5.2'));
  assert.equal(prefixedAlias.providerId, 'openai');
  assert.equal(prefixedAlias.keyAlias, '3-main');

  const numericAlias = JSON.parse(parseProviderKey('tabglm.12'));
  assert.equal(numericAlias.providerId, 'tabglm');
  assert.equal(numericAlias.keyAlias, undefined);
  assert.equal(numericAlias.modelId, '12');

  const dottedModel = JSON.parse(parseProviderKey('tabglm.12.extra'));
  assert.equal(dottedModel.providerId, 'tabglm');
  assert.equal(dottedModel.keyAlias, '12');

  console.log('virtual-router-provider-key-native passed');
}

main().catch((error) => {
  console.error('virtual-router-provider-key-native failed:', error);
  process.exit(1);
});
