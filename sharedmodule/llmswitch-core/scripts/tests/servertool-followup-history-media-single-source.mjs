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
    for (const entry of Object.values(value)) collectInlineBase64Strings(entry, out);
  }
  return out;
}

async function main() {
  const { buildServerToolFollowupChatPayloadFromInjection } = await import(
    path.join(projectRoot, 'dist', 'servertool', 'handlers', 'followup-request-builder.js')
  );
  const { HubPipeline } = await import(
    path.join(projectRoot, 'dist', 'conversion', 'hub', 'pipeline', 'hub-pipeline.js')
  );
  const { bootstrapVirtualRouterConfig } = await import(
    path.join(projectRoot, 'dist', 'router', 'virtual-router', 'bootstrap.js')
  );

  const capturedChatRequest = {
    model: 'glm-4.7',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: '看这张历史图' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'call_view_1',
        name: 'view_image',
        content: '[{"type":"input_image","image_url":"data:image/png;base64,BBB"}]',
      },
    ],
    tools: [
      {
        type: 'function',
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
  };

  const followupPayload = buildServerToolFollowupChatPayloadFromInjection({
    adapterContext: { capturedChatRequest },
    chatResponse: {
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: '我继续处理' },
          finish_reason: 'stop',
        },
      ],
    },
    injection: { ops: [{ op: 'append_user_text', text: '继续分析' }] },
  });

  assert.ok(followupPayload, 'followup payload should be built');
  const rawFollowupPayload = JSON.stringify(followupPayload);
  assert.match(
    rawFollowupPayload,
    /data:image\/png;base64,AAA/,
    'followup builder should preserve captured user-image history and leave cleanup to chat_process entry',
  );
  assert.match(
    rawFollowupPayload,
    /data:image\/png;base64,BBB/,
    'followup builder should preserve captured visual tool output history and leave cleanup to chat_process entry',
  );

  const { config: virtualRouter } = bootstrapVirtualRouterConfig(
    createVirtualRouterBootstrapInput(),
  );
  const hubPipeline = new HubPipeline({ virtualRouter });

  const result = await hubPipeline.execute({
    id: 'req_servertool_followup_history_media_single_source',
    endpoint: '/v1/chat/completions',
    payload: followupPayload,
    metadata: {
      providerProtocol: 'openai',
      processMode: 'chat',
      direction: 'request',
      stage: 'inbound',
      stream: false,
      __disableHubSnapshots: true,
    },
  });

  assert.equal(
    collectInlineBase64Strings(result.providerPayload).length,
    0,
    'chat_process entry should be the only active place that strips historical followup media',
  );
  assert.match(
    JSON.stringify(result.providerPayload),
    /\[Image omitted\]/,
    'provider payload should keep placeholder for stripped followup history media',
  );

  hubPipeline.dispose();
  console.log('✅ servertool followup history media single-source regression passed');
}

main().catch((error) => {
  console.error('❌ servertool followup history media single-source regression failed:', error);
  process.exit(1);
});
