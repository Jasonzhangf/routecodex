#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');

const KEY_A = 'antigravity.a.gemini-3-pro-high';
const KEY_B = 'antigravity.b.gemini-3-pro-high';

async function main() {
  const { VirtualRouterEngine } = await import(path.resolve(repoRoot, 'dist/router/virtual-router/engine.js'));

  const engine = new VirtualRouterEngine();
  engine.initialize(buildConfig());

  const meta = buildMetadata('req_1', { sessionId: 's1', routeHint: 'thinking' });
  const first = engine.route(buildRequest('hi'), meta);

  // Selection-time leasing is allowed, but session binding must only be committed after success.
  assert.equal(
    (engine.antigravitySessionAliasStore && engine.antigravitySessionAliasStore.size) || 0,
    0,
    '[antigravity] should not commit sessionAliasStore before provider success'
  );

  engine.handleProviderSuccess({
    runtime: { requestId: 'req_1', providerKey: first.decision.providerKey },
    timestamp: Date.now(),
    metadata: { sessionId: 's1' }
  });

  assert.equal(
    engine.antigravitySessionAliasStore.get('session:s1::gemini'),
    'antigravity.a::gemini',
    '[antigravity] should commit alias binding after provider success'
  );

  // When quota marks the bound alias out-of-pool, the binding should be released so the session can rebind.
  engine.updateDeps({
    quotaView: (providerKey) => {
      if (String(providerKey).startsWith('antigravity.a.')) return { providerKey, inPool: false };
      return { providerKey, inPool: true };
    }
  });

  const second = engine.route(buildRequest('again'), buildMetadata('req_2', { sessionId: 's1', routeHint: 'thinking' }));
  assert.equal(
    engine.antigravitySessionAliasStore.has('session:s1::gemini'),
    false,
    '[antigravity] should release binding when the pinned alias is out-of-pool'
  );
  assert.equal(
    second.decision.providerKey,
    KEY_B,
    '[antigravity] should route to the next in-pool alias after releasing binding'
  );

  console.log('[virtual-router-antigravity-session-binding] tests passed');
}

function buildConfig() {
  const auth = { type: 'oauth', tokenFile: '/tmp/fake.json' };
  return {
    routing: {
      default: [buildPool('default-primary', [KEY_A, KEY_B], 100)],
      thinking: [buildPool('thinking-primary', [KEY_A, KEY_B], 200)]
    },
    providers: {
      [KEY_A]: buildProviderProfile(KEY_A, auth),
      [KEY_B]: buildProviderProfile(KEY_B, auth)
    },
    classifier: { longContextThresholdTokens: 1000 },
    contextRouting: { warnRatio: 0.75, hardLimit: false },
    loadBalancing: { strategy: 'round-robin' }
  };
}

function buildProviderProfile(providerKey, auth) {
  const parts = String(providerKey).split('.');
  const runtimeKey = parts.length >= 2 ? `${parts[0]}.${parts[1]}` : providerKey;
  const modelId = parts.length >= 3 ? parts.slice(2).join('.') : providerKey;
  return {
    providerKey,
    providerType: 'gemini',
    endpoint: `https://example.invalid/${providerKey}`,
    auth,
    outboundProfile: 'chat:gemini',
    compatibilityProfile: 'compat:passthrough',
    runtimeKey,
    modelId,
    processMode: 'chat',
    streaming: 'auto',
    maxContextTokens: 128000
  };
}

function buildRequest(text) {
  return {
    model: 'antigravity-test-model',
    messages: [{ role: 'user', content: text }],
    tools: [],
    metadata: {}
  };
}

function buildMetadata(requestId, extra = {}) {
  return {
    requestId,
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
  console.error('[virtual-router-antigravity-session-binding] failed:', err);
  process.exit(1);
});
