#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

function importFresh(relPath, tag) {
  const moduleUrl = pathToFileURL(path.join(repoRoot, 'dist', relPath)).href;
  return import(`${moduleUrl}?case=${tag}_${Date.now()}_${Math.random().toString(16).slice(2)}`);
}

async function main() {
  const hotpath = await importFresh('native/router-hotpath/native-router-hotpath.js', 'hotpath');

  const nativeParsed = hotpath.analyzeProviderKey('iflow.3-138.kimi-k2.5');
  assert.equal(nativeParsed.providerId, 'iflow');
  assert.equal(nativeParsed.alias, '3-138');
  assert.equal(nativeParsed.source, 'native');

  const prefixedAlias = hotpath.analyzeProviderKey('openai.3-main.gpt-5.2');
  assert.equal(prefixedAlias.providerId, 'openai');
  assert.equal(prefixedAlias.alias, '3-main');

  const numericAlias = hotpath.analyzeProviderKey('tabglm.12');
  assert.equal(numericAlias.providerId, 'tabglm');
  assert.equal(numericAlias.alias, null);
  assert.equal(numericAlias.keyIndex, 12);

  const dottedModel = hotpath.analyzeProviderKey('tabglm.12.extra');
  assert.equal(dottedModel.providerId, 'tabglm');
  assert.equal(dottedModel.alias, '12');

  console.log('✅ virtual-router-provider-key-native passed');
}

main().catch((error) => {
  console.error('❌ virtual-router-provider-key-native failed:', error);
  process.exit(1);
});
