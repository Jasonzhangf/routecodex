#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');

const KEY_A1 = 'antigravity.1-alpha.testmodel';
const KEY_A2 = 'antigravity.2-bravo.testmodel';
const KEY_TAB = 'tab.1-charlie.testmodel';

async function main() {
  const { VirtualRouterEngine } = await import(path.resolve(repoRoot, 'dist/router/virtual-router/engine.js'));

  {
    // 1) Baseline: picks antigravity (sticky-queue pinning) when healthy.
    const engine = new VirtualRouterEngine();
    engine.initialize(buildConfig());
    const result = engine.route(buildRequest(), buildMetadata('baseline'));
    assert.equal(result.decision.providerKey, KEY_A1, '[antigravity] baseline should pin to alias1');
  }

  {
    // 2) Recovery attempt (excludedProviderKeys present) still rotates within antigravity by default.
    const engine = new VirtualRouterEngine();
    engine.initialize(buildConfig());
    const result = engine.route(
      buildRequest(),
      buildMetadata('recovery_once', { excludedProviderKeys: [KEY_A1] })
    );
    assert.equal(result.decision.providerKey, KEY_A2, '[antigravity] first recovery attempt should rotate to alias2');
  }

  {
    // 3) After two consecutive identical errors, prefer non-antigravity targets when available.
    const engine = new VirtualRouterEngine();
    engine.initialize(buildConfig());
    const result = engine.route(
      buildRequest(),
      buildMetadata('recovery_repeat', {
        excludedProviderKeys: [KEY_A1],
        __rt: {
          antigravityRetryErrorSignature: '429:HTTP_429',
          antigravityRetryErrorConsecutive: 2
        }
      })
    );
    assert.equal(
      result.decision.providerKey,
      KEY_TAB,
      '[antigravity] repeated error should prefer non-antigravity fallback when available'
    );
  }

  console.log('[virtual-router-antigravity-retry-fallback] tests passed');
}

function buildConfig() {
  return {
    routing: {
      default: [buildPool('default-primary', [KEY_A1, KEY_A2, KEY_TAB], 100)]
    },
    providers: {
      [KEY_A1]: buildProviderProfile(KEY_A1, { providerId: 'antigravity' }),
      [KEY_A2]: buildProviderProfile(KEY_A2, { providerId: 'antigravity' }),
      [KEY_TAB]: buildProviderProfile(KEY_TAB, { providerId: 'tab' })
    },
    classifier: { longContextThresholdTokens: 1000 },
    contextRouting: { warnRatio: 0.75, hardLimit: false },
    loadBalancing: { strategy: 'round-robin' }
  };
}

function buildProviderProfile(providerKey, overrides = {}) {
  const providerId = overrides.providerId || providerKey.split('.')[0];
  return {
    providerKey,
    providerType: 'openai',
    providerId,
    endpoint: `https://example.com/${providerKey}`,
    auth: { type: 'apiKey', secretRef: `${providerKey}_KEY` },
    outboundProfile: 'openai-chat',
    compatibilityProfile: 'compat:passthrough',
    modelId: providerKey.split('.').pop(),
    processMode: 'chat',
    streaming: 'auto',
    maxContextTokens: 128000
  };
}

function buildRequest() {
  return {
    model: 'antigravity-test-model',
    messages: [{ role: 'user', content: 'ping' }],
    tools: [],
    metadata: {}
  };
}

function buildMetadata(suffix, extra = {}) {
  return {
    requestId: `req_antigravity_retry_${suffix}`,
    entryEndpoint: '/v1/chat/completions',
    processMode: 'chat',
    stream: false,
    direction: 'request',
    ...extra
  };
}

function buildPool(id, targets, priority = 100) {
  return {
    id,
    priority,
    mode: 'round-robin',
    targets
  };
}

main().catch((err) => {
  console.error('[virtual-router-antigravity-retry-fallback] failed:', err);
  process.exit(1);
});

