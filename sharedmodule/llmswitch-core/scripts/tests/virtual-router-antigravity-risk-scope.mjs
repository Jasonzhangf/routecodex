#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');

const KEY_A1 = 'antigravity.a.model1';
const KEY_A2 = 'antigravity.a.model2';
const KEY_B1 = 'antigravity.b.model1';

async function main() {
  const { ProviderRegistry } = await import(path.resolve(repoRoot, 'dist/router/virtual-router/provider-registry.js'));
  const { ProviderHealthManager } = await import(path.resolve(repoRoot, 'dist/router/virtual-router/health-manager.js'));
  const { applyAntigravityRiskPolicyImpl } = await import(path.resolve(repoRoot, 'dist/router/virtual-router/engine-health.js'));

  {
    // Google account verification should only cooldown the failing runtimeKey.
    const registry = new ProviderRegistry(buildProfiles());
    const health = new ProviderHealthManager();
    health.registerProviders(registry.listProviderKeys('antigravity'));
    const cooled = [];

    const event = buildEvent({
      stage: 'provider.http.test_google_verify_scope',
      message:
        'HTTP 403: { "error": { "code": 403, "message": "To continue, verify your account at https://accounts.google.com/signin/continue?sarp=1" } }',
      providerKey: KEY_A1,
      runtimeKey: 'antigravity.a'
    });

    for (let i = 0; i < 3; i++) {
      applyAntigravityRiskPolicyImpl(event, registry, health, (providerKey) => cooled.push(providerKey));
    }

    assert.deepEqual(
      cooled.slice().sort(),
      [KEY_A1, KEY_A2].sort(),
      '[antigravity] google verify error should only cooldown runtimeKey=antigravity.a'
    );
    assert.equal(health.isAvailable(KEY_A1), false);
    assert.equal(health.isAvailable(KEY_A2), false);
    assert.equal(health.isAvailable(KEY_B1), true);
  }

  {
    // Other 4xx policy failures remain global to avoid unsafe blasting across accounts.
    const registry = new ProviderRegistry(buildProfiles());
    const health = new ProviderHealthManager();
    health.registerProviders(registry.listProviderKeys('antigravity'));
    const cooled = [];

    const event = buildEvent({
      stage: 'provider.http.test_global_scope',
      message: 'HTTP 403: { "error": { "code": 403, "message": "access denied" } }',
      providerKey: KEY_A1,
      runtimeKey: 'antigravity.a'
    });

    for (let i = 0; i < 3; i++) {
      applyAntigravityRiskPolicyImpl(event, registry, health, (providerKey) => cooled.push(providerKey));
    }

    assert.deepEqual(
      cooled.slice().sort(),
      [KEY_A1, KEY_A2, KEY_B1].sort(),
      '[antigravity] non-verification 4xx should cooldown all antigravity keys (global)'
    );
    assert.equal(health.isAvailable(KEY_A1), false);
    assert.equal(health.isAvailable(KEY_A2), false);
    assert.equal(health.isAvailable(KEY_B1), false);
  }

  console.log('[virtual-router-antigravity-risk-scope] tests passed');
}

function buildProfiles() {
  return {
    [KEY_A1]: buildProviderProfile(KEY_A1, { runtimeKey: 'antigravity.a' }),
    [KEY_A2]: buildProviderProfile(KEY_A2, { runtimeKey: 'antigravity.a' }),
    [KEY_B1]: buildProviderProfile(KEY_B1, { runtimeKey: 'antigravity.b' })
  };
}

function buildProviderProfile(providerKey, overrides = {}) {
  const runtimeKey = overrides.runtimeKey;
  return {
    providerKey,
    providerType: 'openai',
    endpoint: `https://example.com/${providerKey}`,
    auth: { type: 'apiKey', secretRef: `${providerKey}_KEY` },
    outboundProfile: 'openai-chat',
    compatibilityProfile: 'compat:passthrough',
    runtimeKey,
    modelId: providerKey.split('.').pop(),
    processMode: 'chat',
    streaming: 'auto',
    maxContextTokens: 128000
  };
}

function buildEvent({ stage, message, providerKey, runtimeKey }) {
  return {
    code: 'HTTP_403',
    message,
    stage,
    status: 403,
    timestamp: Date.now(),
    runtime: {
      requestId: `req_${stage}`,
      providerId: 'antigravity',
      providerKey,
      target: { providerKey, runtimeKey, modelId: providerKey.split('.').pop() }
    }
  };
}

main().catch((err) => {
  console.error('[virtual-router-antigravity-risk-scope] failed:', err);
  process.exit(1);
});

