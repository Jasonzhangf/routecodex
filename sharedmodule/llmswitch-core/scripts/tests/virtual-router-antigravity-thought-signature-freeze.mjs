#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');

const KEY_GEMINI_PRO = 'antigravity.a.gemini-3-pro-high';
const KEY_GEMINI_FLASH = 'antigravity.a.gemini-2.5-flash';
const KEY_CLAUDE = 'antigravity.a.claude-sonnet-4-5-thinking';
const KEY_OTHER_RUNTIME = 'antigravity.b.gemini-3-pro-high';

async function main() {
  const { ProviderRegistry } = await import(path.resolve(repoRoot, 'dist/router/virtual-router/provider-registry.js'));
  const { ProviderHealthManager } = await import(path.resolve(repoRoot, 'dist/router/virtual-router/health-manager.js'));
  const { applyAntigravityRiskPolicyImpl } = await import(path.resolve(repoRoot, 'dist/router/virtual-router/engine-health.js'));

  const registry = new ProviderRegistry(buildProfiles());
  const health = new ProviderHealthManager();
  health.registerProviders(registry.listProviderKeys('antigravity'));
  const cooled = [];

  const event = buildEvent({
    status: 400,
    code: 'HTTP_400',
    stage: 'provider.http.test_signature_missing',
    message: 'HTTP 400: missing thoughtSignature (required for tool call)',
    providerKey: KEY_GEMINI_PRO,
    runtimeKey: 'antigravity.a'
  });

  applyAntigravityRiskPolicyImpl(event, registry, health, (providerKey) => cooled.push(providerKey));

  assert.deepEqual(
    cooled.slice().sort(),
    [KEY_GEMINI_PRO, KEY_GEMINI_FLASH].sort(),
    '[antigravity] missing thoughtSignature should immediately cooldown gemini-pro/flash within the same runtimeKey'
  );
  assert.equal(health.isAvailable(KEY_GEMINI_PRO), false);
  assert.equal(health.isAvailable(KEY_GEMINI_FLASH), false);
  assert.equal(health.isAvailable(KEY_CLAUDE), true, 'claude series must not be frozen by gemini signature policy');
  assert.equal(health.isAvailable(KEY_OTHER_RUNTIME), true, 'other antigravity runtimeKeys must not be penalized');

  console.log('[virtual-router-antigravity-thought-signature-freeze] tests passed');
}

function buildProfiles() {
  return {
    [KEY_GEMINI_PRO]: buildProviderProfile(KEY_GEMINI_PRO, { runtimeKey: 'antigravity.a' }),
    [KEY_GEMINI_FLASH]: buildProviderProfile(KEY_GEMINI_FLASH, { runtimeKey: 'antigravity.a' }),
    [KEY_CLAUDE]: buildProviderProfile(KEY_CLAUDE, { runtimeKey: 'antigravity.a' }),
    [KEY_OTHER_RUNTIME]: buildProviderProfile(KEY_OTHER_RUNTIME, { runtimeKey: 'antigravity.b' })
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

function buildEvent({ stage, message, providerKey, runtimeKey, status, code }) {
  return {
    code,
    message,
    stage,
    status,
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
  console.error('[virtual-router-antigravity-thought-signature-freeze] failed:', err);
  process.exit(1);
});

