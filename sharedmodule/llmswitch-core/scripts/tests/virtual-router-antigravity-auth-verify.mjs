#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');

const KEY_A_HIGH = 'antigravity.a.gemini-3-pro-high';
const KEY_A_LOW = 'antigravity.a.gemini-3-pro-low';
const KEY_B_HIGH = 'antigravity.b.gemini-3-pro-high';

async function main() {
  const { VirtualRouterEngine } = await import(path.resolve(repoRoot, 'dist/router/virtual-router/engine.js'));

  const engine = new VirtualRouterEngine();
  engine.initialize(buildConfig());

  // Baseline: pins to account "a" while healthy (sticky-queue).
  const first = engine.route(buildRequest(), buildMetadata('baseline_1'));
  assert.equal(first.decision.providerKey, KEY_A_HIGH, '[antigravity] baseline should pin to first alias');

  // Emit Google account verification-required error for alias "a".
  engine.handleProviderError({
    code: 'HTTP_403',
    message:
      'HTTP 403: To continue, verify your account at https://accounts.google.com/signin/continue ... https://support.google.com/accounts?p=al_alert',
    stage: 'provider.http',
    status: 403,
    recoverable: false,
    runtime: {
      requestId: 'req_auth_verify',
      routeName: 'default',
      providerKey: KEY_A_HIGH,
      providerType: 'gemini',
      providerProtocol: 'gemini-chat',
      pipelineId: 'pipeline-default'
    },
    timestamp: Date.now(),
    details: {
      upstreamMessage:
        'To continue, verify your account at https://accounts.google.com/signin/continue ... https://support.google.com/accounts?p=al_alert'
    }
  });

  // After auth-verify, both keys under runtimeKey "antigravity.a" must be cooled down,
  // and routing should move to the next alias (account "b") rather than affecting all accounts.
  const after = engine.route(buildRequest(), buildMetadata('after_verify'));
  assert.equal(
    after.decision.providerKey,
    KEY_B_HIGH,
    '[antigravity] auth-verify should blacklist only the affected runtimeKey and allow other accounts'
  );

  console.log('[virtual-router-antigravity-auth-verify] tests passed');
}

function buildConfig() {
  return {
    routing: {
      default: [buildPool('default-primary', [KEY_A_HIGH, KEY_A_LOW, KEY_B_HIGH], 100)]
    },
    providers: {
      [KEY_A_HIGH]: buildProviderProfile(KEY_A_HIGH),
      [KEY_A_LOW]: buildProviderProfile(KEY_A_LOW),
      [KEY_B_HIGH]: buildProviderProfile(KEY_B_HIGH)
    },
    classifier: { longContextThresholdTokens: 1000 },
    contextRouting: { warnRatio: 0.75, hardLimit: false },
    loadBalancing: { strategy: 'round-robin' }
  };
}

function buildProviderProfile(providerKey) {
  return {
    providerKey,
    providerType: 'gemini',
    endpoint: `https://example.com/${providerKey}`,
    auth: { type: 'apiKey', secretRef: `${providerKey}_KEY` },
    outboundProfile: 'gemini-chat',
    compatibilityProfile: 'compat:passthrough',
    modelId: providerKey.split('.').pop(),
    processMode: 'chat',
    streaming: 'auto',
    maxContextTokens: 128000
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
    requestId: `req_antigravity_verify_${suffix}`,
    entryEndpoint: '/v1/chat/completions',
    processMode: 'chat',
    stream: false,
    direction: 'request',
    ...extra
  };
}

main().catch((err) => {
  console.error('[virtual-router-antigravity-auth-verify] failed:', err);
  process.exit(1);
});

