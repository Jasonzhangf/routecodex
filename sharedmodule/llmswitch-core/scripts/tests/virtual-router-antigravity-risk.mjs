#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');

const KEY_A1 = 'antigravity.alpha.testmodel';
const KEY_A2 = 'antigravity.bravo.testmodel';
const KEY_O1 = 'openai.key1.gpt-test';

async function main() {
  const { VirtualRouterEngine } = await import(path.resolve(repoRoot, 'dist/router/virtual-router/engine.js'));

  const engine = new VirtualRouterEngine();
  engine.initialize(buildConfig());

  // Baseline: should pick Antigravity (primary pool).
  const first = engine.route(buildRequest(), buildMetadata('baseline'));
  assert.ok(
    String(first.decision.providerKey || '').startsWith('antigravity.'),
    '[antigravity-risk] baseline should select antigravity from primary pool'
  );

  // Emit the same Antigravity 4xx error signature repeatedly.
  // 1st/2nd: no provider-wide cooldown yet (per-request retry/fallback handles immediate behavior).
  engine.handleProviderError(buildAntigravityError('sig1', 1));
  engine.handleProviderError(buildAntigravityError('sig1', 2));

  // Do not assert which key is selected here: the engine may already avoid the failing alias/model.

  // 3rd: triggers a provider-wide cooldown (5m default), should route to non-antigravity key.
  engine.handleProviderError(buildAntigravityError('sig1', 3));
  const cooled = engine.route(buildRequest(), buildMetadata('cooldown'));
  assert.equal(
    cooled.decision.providerKey,
    KEY_O1,
    '[antigravity-risk] after escalation, routing should avoid antigravity and select fallback provider'
  );

  // 4th: triggers a longer "blacklist" window; should still avoid antigravity.
  engine.handleProviderError(buildAntigravityError('sig1', 4));
  const blacklisted = engine.route(buildRequest(), buildMetadata('blacklist'));
  assert.equal(
    blacklisted.decision.providerKey,
    KEY_O1,
    '[antigravity-risk] after blacklist escalation, routing should continue avoiding antigravity'
  );

  console.log('[virtual-router-antigravity-risk] tests passed');
}

function buildConfig() {
  return {
    routing: {
      default: [
        buildPool('default-primary', [KEY_A1, KEY_A2], 100),
        buildPool('default-backup', [KEY_O1], 200, { backup: true, mode: 'priority' })
      ]
    },
    providers: {
      [KEY_A1]: buildProviderProfile(KEY_A1, 'openai'),
      [KEY_A2]: buildProviderProfile(KEY_A2, 'openai'),
      [KEY_O1]: buildProviderProfile(KEY_O1, 'openai')
    },
    classifier: { longContextThresholdTokens: 1000 },
    contextRouting: { warnRatio: 0.75, hardLimit: false },
    loadBalancing: {
      strategy: 'round-robin',
      aliasSelection: { antigravity: 'sticky-queue' }
    }
  };
}

function buildProviderProfile(providerKey, providerType) {
  return {
    providerKey,
    providerType,
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
    requestId: `req_antigravity_risk_${suffix}`,
    entryEndpoint: '/v1/chat/completions',
    processMode: 'chat',
    stream: false,
    direction: 'request',
    ...extra
  };
}

function buildPool(id, targets, priority = 100, extra = {}) {
  return {
    id,
    priority,
    mode: 'round-robin',
    targets,
    ...extra
  };
}

function buildAntigravityError(signature, idx) {
  return {
    code: 'HTTP_403',
    message: `fake 403 error ${signature}`,
    stage: 'provider.provider.http',
    status: 403,
    recoverable: false,
    affectsHealth: true,
    runtime: {
      requestId: `req_err_${signature}_${idx}`,
      routeName: 'default',
      providerKey: KEY_A1,
      providerId: 'antigravity',
      providerType: 'gemini',
      providerProtocol: 'gemini-chat'
    },
    timestamp: Date.now()
  };
}

main().catch((err) => {
  console.error('[virtual-router-antigravity-risk] failed:', err);
  process.exit(1);
});
