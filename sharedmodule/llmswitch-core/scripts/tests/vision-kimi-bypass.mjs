#!/usr/bin/env node
/**
 * Regression: when routed model is kimi-k2.5 (inline multimodal),
 * vision_auto must not trigger the legacy :vision detour.
 */

import assert from 'node:assert/strict';
import { listAutoServerToolHandlers } from '../../dist/servertool/registry.js';
import '../../dist/servertool/handlers/vision.js';

async function main() {
  const entry = listAutoServerToolHandlers().find((h) => h && h.name === 'vision_auto');
  assert.ok(entry, 'missing vision_auto handler registration');

  const ctx = {
    base: {},
    toolCalls: [],
    adapterContext: {
      requestId: 'req_vision_kimi_bypass',
      entryEndpoint: '/v1/responses',
      providerType: 'openai',
      providerProtocol: 'openai-chat',
      modelId: 'kimi-k2.5',
      hasImageAttachment: true
    },
    requestId: 'req_vision_kimi_bypass',
    entryEndpoint: '/v1/responses',
    providerProtocol: 'openai-chat',
    capabilities: { reenterPipeline: true, providerInvoker: false }
  };

  const plan = await entry.handler(ctx);
  assert.equal(plan, null, 'expected vision_auto to skip legacy detour for kimi-k2.5');

  // eslint-disable-next-line no-console
  console.log('[matrix:vision-kimi-bypass] ok');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[matrix:vision-kimi-bypass] failed', err);
  process.exit(1);
});

