#!/usr/bin/env node

import assert from 'node:assert/strict';
import { ProviderRegistry } from '../../dist/router/virtual-router/provider-registry.js';
import { buildRouteCandidates } from '../../dist/router/virtual-router/engine-selection/route-utils.js';

async function main() {
  const providerRegistry = new ProviderRegistry({
    'iflow.2-173.kimi-k2.5': {
      providerKey: 'iflow.2-173.kimi-k2.5',
      providerType: 'openai',
      endpoint: 'https://example.com',
      auth: { type: 'apikey', value: 'x' },
      outboundProfile: 'openai-chat',
      modelId: 'kimi-k2.5'
    },
    'iflow.2-173.qwen3-vl-plus': {
      providerKey: 'iflow.2-173.qwen3-vl-plus',
      providerType: 'openai',
      endpoint: 'https://example.com',
      auth: { type: 'apikey', value: 'x' },
      outboundProfile: 'openai-chat',
      modelId: 'qwen3-vl-plus'
    },
    'tab.key1.gpt-5.2-codex': {
      providerKey: 'tab.key1.gpt-5.2-codex',
      providerType: 'responses',
      endpoint: 'https://example.com',
      auth: { type: 'apikey', value: 'x' },
      outboundProfile: 'openai-responses',
      modelId: 'gpt-5.2-codex'
    }
  });

  const routing = {
    multimodal: [
      {
        id: 'multimodal-primary',
        priority: 200,
        mode: 'priority',
        targets: ['iflow.2-173.kimi-k2.5']
      },
      {
        id: 'multimodal-backup',
        priority: 100,
        mode: 'priority',
        backup: true,
        targets: ['tab.key1.gpt-5.2-codex']
      }
    ],
    vision: [
      {
        id: 'vision-primary',
        priority: 100,
        mode: 'priority',
        targets: ['iflow.2-173.qwen3-vl-plus'],
        force: true
      }
    ],
    coding: [
      {
        id: 'coding-primary',
        priority: 100,
        mode: 'priority',
        targets: ['iflow.2-173.kimi-k2.5']
      }
    ],
    default: [
      {
        id: 'default-primary',
        priority: 100,
        mode: 'priority',
        targets: ['tab.key1.gpt-5.2-codex']
      }
    ]
  };

  const mediaFeatures = {
    requestId: 'req_media_kimi',
    model: 'gpt-test',
    totalMessages: 1,
    userTextSample: 'check image',
    toolCount: 0,
    hasTools: false,
    hasToolCallResponses: false,
    hasVisionTool: false,
    hasImageAttachment: true,
    hasWebTool: false,
    hasCodingTool: false,
    hasThinkingKeyword: false,
    estimatedTokens: 128,
    latestMessageFromUser: true,
    metadata: { requestId: 'req_media_kimi' }
  };

  const candidates = buildRouteCandidates('multimodal', ['multimodal'], mediaFeatures, routing, providerRegistry);
  assert.equal(candidates[0], 'multimodal', 'media route should prefer multimodal route first');

  const routingWithoutMultimodal = {
    vision: routing.vision,
    coding: routing.coding,
    default: routing.default
  };
  const fallbackCandidates = buildRouteCandidates(
    'multimodal',
    ['multimodal'],
    mediaFeatures,
    routingWithoutMultimodal,
    providerRegistry
  );
  assert.equal(fallbackCandidates[0], 'vision', 'media route should fallback to vision when multimodal is missing');

  const textFeatures = { ...mediaFeatures, hasImageAttachment: false, requestId: 'req_text_only' };
  const textCandidates = buildRouteCandidates('vision', ['vision'], textFeatures, routing, providerRegistry);
  assert.equal(textCandidates[0], 'vision', 'non-media route should keep original priority');

  console.log('[matrix:virtual-router-media-kimi-route] ok');
}

main().catch((err) => {
  console.error('[matrix:virtual-router-media-kimi-route] failed', err);
  process.exit(1);
});
