#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');

const KEY_A1 = 'antigravity.1-alpha.testmodel';
const KEY_A2 = 'antigravity.2-bravo.testmodel';
const KEY_G1 = 'gemini-cli.1-alpha.testmodel';

async function main() {
  const { VirtualRouterEngine } = await import(path.resolve(repoRoot, 'dist/router/virtual-router/engine.js'));

  {
    // 1) Pins to the first alias (config order) while healthy.
    const engine = new VirtualRouterEngine();
    engine.initialize(buildConfig());

    for (let i = 0; i < 10; i++) {
      const result = engine.route(buildRequest(), buildMetadata(`pin_${i}`));
      assert.equal(result.decision.providerKey, KEY_A1, '[antigravity] should pin to first alias when healthy');
    }
  }

  {
    // 1b) Pins even when sessionId is present.
    const engine = new VirtualRouterEngine();
    engine.initialize(buildConfig());

    for (let i = 0; i < 10; i++) {
      const result = engine.route(buildRequest(), buildMetadata(`pin_session_${i}`, { sessionId: 'sess-pin' }));
      assert.equal(result.decision.providerKey, KEY_A1, '[antigravity] should pin to first alias within session');
    }
  }

  {
    // 2) Fails over to the next alias when the current alias becomes unavailable.
    const engine = new VirtualRouterEngine();
    engine.initialize(buildConfig());

    engine.handleProviderFailure({
      providerKey: KEY_A1,
      fatal: true,
      affectsHealth: true,
      reason: 'test:make_alias1_unhealthy'
    });

    const result = engine.route(buildRequest(), buildMetadata('failover'));
    assert.equal(result.decision.providerKey, KEY_A2, '[antigravity] should fail over to next alias when unhealthy');
  }

  {
    // 3) Recovery attempt (excludedProviderKeys present) rotates the alias to the tail,
    //    and the next normal request stays sticky to the new head alias.
    const engine = new VirtualRouterEngine();
    engine.initialize(buildConfig());

    const first = engine.route(buildRequest(), buildMetadata('recovery_1', { excludedProviderKeys: [KEY_A1] }));
    assert.equal(first.decision.providerKey, KEY_A2, '[antigravity] excluded providerKey should route to next alias');

    const follow = engine.route(buildRequest(), buildMetadata('recovery_2'));
    assert.equal(
      follow.decision.providerKey,
      KEY_A2,
      '[antigravity] after exclusion, routing should remain sticky to the next alias until it fails'
    );

    const rotateBack = engine.route(buildRequest(), buildMetadata('recovery_3', { excludedProviderKeys: [KEY_A2] }));
    assert.equal(rotateBack.decision.providerKey, KEY_A1, '[antigravity] second exclusion should rotate back to alias1');
  }

  {
    // 4) Antigravity safety: when a retry is marked as "avoid all antigravity",
    //    router must not fall back to other Antigravity aliases.
    const engine = new VirtualRouterEngine();
    engine.initialize(buildConfig({ includeNonAntigravity: true }));

    const result = engine.route(
      buildRequest(),
      buildMetadata('avoid_all_on_retry', {
        excludedProviderKeys: [KEY_A1],
        __rt: { antigravityAvoidAllOnRetry: true, antigravityRetryErrorSignature: '403:GOOGLE_VERIFY', antigravityRetryErrorConsecutive: 1 }
      })
    );
    assert.equal(result.decision.providerKey, KEY_G1, '[antigravity] avoidAllOnRetry should prefer non-antigravity fallback');
  }

  console.log('[virtual-router-antigravity-alias-pin] tests passed');
}

function buildConfig(options = {}) {
  const includeNonAntigravity = options.includeNonAntigravity === true;
  return {
    routing: {
      default: [buildPool('default-primary', includeNonAntigravity ? [KEY_A1, KEY_A2, KEY_G1] : [KEY_A1, KEY_A2], 100)]
    },
    providers: {
      [KEY_A1]: buildProviderProfile(KEY_A1),
      [KEY_A2]: buildProviderProfile(KEY_A2),
      ...(includeNonAntigravity ? { [KEY_G1]: buildProviderProfile(KEY_G1) } : {})
    },
    classifier: { longContextThresholdTokens: 1000 },
    contextRouting: { warnRatio: 0.75, hardLimit: false },
    loadBalancing: { strategy: 'round-robin' }
  };
}

function buildProviderProfile(providerKey) {
  return {
    providerKey,
    providerType: 'openai',
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
    requestId: `req_antigravity_${suffix}`,
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
  console.error('[virtual-router-antigravity-alias-pin] failed:', err);
  process.exit(1);
});
