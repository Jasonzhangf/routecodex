#!/usr/bin/env node

import assert from 'node:assert/strict';
import path from 'node:path';

const projectRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
  '..',
);

function createVirtualRouterBootstrapInput() {
  return {
    virtualrouter: {
      providers: {
        tab: {
          type: 'openai',
          endpoint: 'http://localhost',
          auth: {
            type: 'apikey',
            keys: { key1: { value: 'dummy' } },
          },
        },
      },
      routing: {
        default: [
          {
            id: 'default:single',
            priority: 100,
            mode: 'priority',
            targets: ['tab.key1.glm-4.7'],
          },
        ],
      },
      classifier: {},
    },
  };
}

function collectInlineBase64Strings(value, out = []) {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (
      (normalized.startsWith('data:') && normalized.includes(';base64,')) ||
      normalized.startsWith('base64,')
    ) {
      out.push(value);
    }
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectInlineBase64Strings(item, out);
    return out;
  }
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) {
      collectInlineBase64Strings(entry, out);
    }
  }
  return out;
}

function hasPlaceholderInResponsesContextInput(value) {
  if (!Array.isArray(value)) {
    return false;
  }
  return value.some((entry) =>
    Array.isArray(entry?.content) &&
    entry.content.some((part) => part?.type === 'input_text' && part?.text === '[Image omitted]')
  );
}

async function main() {
  const { HubPipeline } = await import(
    path.join(projectRoot, 'dist', 'conversion', 'hub', 'pipeline', 'hub-pipeline.js')
  );
  const { bootstrapVirtualRouterConfig } = await import(
    path.join(projectRoot, 'dist', 'router', 'virtual-router', 'bootstrap.js')
  );

  const { config: virtualRouter } = bootstrapVirtualRouterConfig(
    createVirtualRouterBootstrapInput(),
  );
  const hubPipeline = new HubPipeline({ virtualRouter });

  const payload = {
    model: 'glm-4.7',
    tools: [
      {
        type: 'function',
        name: 'view_image',
        description: 'view image',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
        function: {
          name: 'view_image',
          description: 'view image',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
        },
      },
    ],
    input: [
      {
        role: 'user',
        content: [
          { type: 'input_image', image_url: 'data:image/png;base64,AAA' },
          { type: 'input_text', text: '请看这张图' },
        ],
      },
      {
        type: 'function_call',
        id: 'fc_view_1',
        call_id: 'fc_view_1',
        name: 'view_image',
        arguments: JSON.stringify({ path: '/tmp/demo.png' }),
      },
      {
        type: 'function_call_output',
        id: 'fc_view_1',
        call_id: 'fc_view_1',
        output: '[{"type":"input_image","image_url":"data:image/png;base64,BBB"}]',
      },
      {
        role: 'user',
        content: [{ type: 'input_text', text: '继续分析' }],
      },
    ],
    store: false,
  };

  const result = await hubPipeline.execute({
    id: 'req_history_media_placeholder',
    endpoint: '/v1/responses',
    payload,
    metadata: {
      providerProtocol: 'openai-responses',
      processMode: 'chat',
      direction: 'request',
      stage: 'inbound',
      stream: false,
      __disableHubSnapshots: true,
    },
  });

  const providerPayload = result.providerPayload;
  const contextInput =
    result.processedRequest?.semantics?.responses?.context?.input ??
    result.standardizedRequest?.semantics?.responses?.context?.input;
  assert.ok(providerPayload && typeof providerPayload === 'object', 'expected provider payload');
  assert.ok(Array.isArray(contextInput), 'expected responses context input');

  const inlineBase64 = collectInlineBase64Strings(providerPayload);
  assert.equal(
    inlineBase64.length,
    0,
    'historical inline image base64 should be stripped before provider payload build',
  );

  const serialized = JSON.stringify(providerPayload);
  assert.match(
    serialized,
    /\[Image omitted\]/,
    'expected historical image placeholder to remain in message history',
  );
  assert.equal(
    collectInlineBase64Strings(contextInput).length,
    0,
    'responses context input should not keep historical inline image base64',
  );
  assert.equal(
    hasPlaceholderInResponsesContextInput(contextInput),
    true,
    'responses context input should keep placeholder text for stripped historical image',
  );
  assert.match(
    JSON.stringify(providerPayload),
    /\[Image omitted\]/,
    'provider payload should keep placeholder for scrubbed visual tool output',
  );

  hubPipeline.dispose();
  console.log('✅ hub pipeline historical media placeholder regression passed');
}

main().catch((error) => {
  console.error('❌ hub pipeline historical media placeholder regression failed:', error);
  process.exit(1);
});
