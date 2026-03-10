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
  const hotpath = await importFresh('router/virtual-router/engine-selection/native-router-hotpath.js', 'hotpath');
  const keyParsing = await importFresh('router/virtual-router/engine-selection/key-parsing.js', 'key-parsing');
  const engineParse = await importFresh('router/virtual-router/engine/provider-key/parse.js', 'engine-parse');

  const nativeParsed = hotpath.analyzeProviderKey('iflow.3-138.kimi-k2.5');
  assert.equal(nativeParsed.providerId, 'iflow');
  assert.equal(nativeParsed.alias, '138');
  assert.equal(nativeParsed.source, 'native');

  const aliasWithPrefix = keyParsing.extractKeyAlias('openai.3-main.gpt-5.2');
  assert.equal(aliasWithPrefix, 'main');
  assert.equal(keyParsing.extractProviderId('openai.3-main.gpt-5.2'), 'openai');
  assert.equal(keyParsing.extractKeyIndex('tabglm.12'), 12);
  assert.equal(keyParsing.extractKeyIndex('tabglm.12.extra'), undefined);

  const providerRegistry = {
    get(key) {
      if (key === 'openai.3-main.gpt-5.2') {
        return { modelId: 'gpt-5.2' };
      }
      return { modelId: '' };
    }
  };

  assert.equal(
    keyParsing.getProviderModelId('openai.3-main.gpt-5.2', providerRegistry),
    'gpt-5.2'
  );

  // engine/provider-key/parse.ts now reuses engine-selection/key-parsing.ts
  assert.equal(engineParse.extractProviderId('openai.3-main.gpt-5.2'), 'openai');
  assert.equal(engineParse.extractKeyAlias('openai.3-main.gpt-5.2'), 'main');
  assert.equal(engineParse.extractKeyIndex('tabglm.12'), 12);

  console.log('✅ virtual-router-provider-key-native passed');
}

main().catch((error) => {
  console.error('❌ virtual-router-provider-key-native failed:', error);
  process.exit(1);
});
