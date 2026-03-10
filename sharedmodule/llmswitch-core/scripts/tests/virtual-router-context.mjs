#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');

const SMALL_KEY = 'ctx.small.main.tiny';
const FALLBACK_KEY = 'ctx.long.main.colossal';

async function main() {
  const { VirtualRouterEngine } = await import(path.resolve(repoRoot, 'dist/router/virtual-router/engine.js'));
  const engine = new VirtualRouterEngine();
  engine.initialize(buildConfig());

  const shortRequest = buildRequest('short ping');
  const longRequest = buildRequest('x'.repeat(8000));

  const shortMeta = buildMetadata('short');
  const longMeta = buildMetadata('long');
  const fallbackMeta = buildMetadata('fallback');

  const shortResult = engine.route(shortRequest, shortMeta);
  assert.equal(
    shortResult.decision.providerKey,
    SMALL_KEY,
    '[context] short payload should stay on thinking route'
  );
  assert.equal(shortResult.decision.routeName, 'thinking');

  const longResult = engine.route(longRequest, longMeta);
  assert.equal(
    longResult.decision.providerKey,
    FALLBACK_KEY,
    '[context] long payload should switch to fallback route'
  );
  assert.equal(longResult.decision.routeName, 'longcontext');

  engine.handleProviderFailure({
    providerKey: FALLBACK_KEY,
    fatal: true,
    affectsHealth: true,
    reason: 'test:fallback_unhealthy'
  });

  const degradedResult = engine.route(longRequest, fallbackMeta);
  assert.equal(
    degradedResult.decision.providerKey,
    FALLBACK_KEY,
    '[context] single-provider pool is never emptied by health/cooldown'
  );
  assert.equal(degradedResult.decision.routeName, 'longcontext');

  console.log('[virtual-router-context] tests passed');
}

function buildConfig() {
  return {
    routing: {
      default: [
        buildPool('default-primary', [SMALL_KEY], 200)
      ],
      thinking: [
        buildPool('thinking-primary', [SMALL_KEY], 150)
      ],
      longcontext: [
        buildPool('longcontext-primary', [FALLBACK_KEY], 100)
      ]
    },
    providers: {
      [SMALL_KEY]: buildProviderProfile(SMALL_KEY, 12000),
      [FALLBACK_KEY]: buildProviderProfile(FALLBACK_KEY, 50000)
    },
    classifier: { longContextThresholdTokens: 1000 },
    loadBalancing: { strategy: 'round-robin' },
    contextRouting: {
      warnRatio: 0.75,
      hardLimit: false
    }
  };
}

function buildProviderProfile(providerKey, maxContextTokens) {
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
    maxContextTokens
  };
}

function buildRequest(content) {
  return {
    model: 'ctx-test-model',
    messages: [{ role: 'user', content }],
    tools: [],
    metadata: {}
  };
}

function buildMetadata(suffix) {
  return {
    requestId: `req_ctx_${suffix}`,
    entryEndpoint: '/v1/chat/completions',
    processMode: 'chat',
    stream: false,
    direction: 'request'
  };
}

function buildPool(id, targets, priority = 100, backup = false) {
  return {
    id,
    targets,
    priority,
    backup
  };
}

main().catch((error) => {
  console.error('[virtual-router-context] failed', error);
  process.exitCode = 1;
});
