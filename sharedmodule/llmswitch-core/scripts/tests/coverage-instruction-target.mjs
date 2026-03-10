#!/usr/bin/env node

import assert from 'node:assert/strict';

async function main() {
  const { resolveInstructionTarget } = await import('../../dist/router/virtual-router/engine-selection/instruction-target.js');

  // Minimal ProviderRegistry stub for resolveInstructionTarget + getProviderModelId(key, registry)
  const profiles = new Map([
    ['tab.key1.gpt-5.2', { modelId: 'gpt-5.2' }],
    ['tab.key2.gpt-5.2', { modelId: 'gpt-5.2' }],
    ['tab.key1.gpt-4.1', { modelId: 'gpt-4.1' }]
  ]);

  const providerRegistry = {
    listProviderKeys(providerId) {
      return Array.from(profiles.keys()).filter((k) => k.startsWith(`${providerId}.`));
    },
    resolveRuntimeKeyByIndex(providerId, index) {
      // 1-based index for this helper in routing-instructions contract
      const keys = this.listProviderKeys(providerId).sort();
      return keys[index - 1];
    },
    resolveRuntimeKeyByAlias(providerId, alias) {
      const prefix = `${providerId}.${alias}.`;
      return Array.from(profiles.keys()).find((k) => k.startsWith(prefix));
    },
    get(key) {
      const p = profiles.get(key);
      if (!p) throw new Error('unknown key');
      return p;
    }
  };

  // 1) alias explicit + model exact → single exact key
  {
    const out = resolveInstructionTarget(
      { provider: 'tab', keyAlias: 'key1', model: 'gpt-4.1', pathLength: 3 },
      providerRegistry
    );
    assert.deepEqual(out, { mode: 'exact', keys: ['tab.key1.gpt-4.1'] });
  }

  // 2) keyIndex exact
  {
    const out = resolveInstructionTarget(
      { provider: 'tab', keyIndex: 2, pathLength: 2 },
      providerRegistry
    );
    assert.equal(out.mode, 'exact');
    assert.equal(out.keys.length, 1);
  }

  // 3) model filter
  {
    const out = resolveInstructionTarget(
      { provider: 'tab', model: 'gpt-5.2', pathLength: 2 },
      providerRegistry
    );
    assert.equal(out.mode, 'filter');
    assert.ok(out.keys.includes('tab.key1.gpt-5.2'));
    assert.ok(out.keys.includes('tab.key2.gpt-5.2'));
  }

  // 4) legacy alias fallback (pathLength != 3)
  {
    const out = resolveInstructionTarget(
      { provider: 'tab', keyAlias: 'key2', pathLength: 2 },
      providerRegistry
    );
    assert.deepEqual(out, { mode: 'exact', keys: ['tab.key2.gpt-5.2'] });
  }

  console.log('✅ coverage-instruction-target passed');
}

main().catch((e) => {
  console.error('❌ coverage-instruction-target failed:', e);
  process.exit(1);
});

