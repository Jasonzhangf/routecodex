#!/usr/bin/env node

import assert from 'node:assert/strict';
import path from 'node:path';

const projectRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
  '..',
);

async function main() {
  const mod = await import(
    path.join(projectRoot, 'dist', 'conversion', 'responses', 'responses-openai-bridge.js')
  );

  const chat = {
    model: 'gpt-5.4',
    messages: [{ role: 'user', content: 'hello' }],
    parameters: {
      model: 'gpt-5.4',
      tool_choice: 'required',
      parallel_tool_calls: true,
      response_format: { type: 'json_schema', json_schema: { name: 'x', schema: { type: 'object' } } },
      service_tier: 'flex',
      truncation: 'auto',
      include: ['reasoning.encrypted_content'],
      store: true,
      stream: true
    },
    metadata: {
      extraFields: {
        response_format: { type: 'text' },
        service_tier: 'default',
        truncation: 'disabled',
        include: ['wrong'],
        store: false,
        stream: false
      }
    }
  };

  const context = {
    requestId: 'req_parameters_single_source',
    toolChoice: 'auto',
    parallelToolCalls: false,
    responseFormat: { type: 'text' },
    serviceTier: 'default',
    truncation: 'disabled',
    include: ['wrong'],
    store: false,
    stream: false,
    parameters: {
      tool_choice: 'none',
      parallel_tool_calls: false,
      response_format: { type: 'text' },
      service_tier: 'default',
      truncation: 'disabled',
      include: ['wrong'],
      store: false,
      stream: false
    },
    metadata: {
      extraFields: {
        response_format: { type: 'text' },
        service_tier: 'default',
        truncation: 'disabled',
        include: ['wrong'],
        store: false,
        stream: false
      }
    }
  };

  const result = mod.buildResponsesRequestFromChat(chat, context);
  assert.equal(result.request.tool_choice, 'required');
  assert.equal(result.request.parallel_tool_calls, true);
  assert.deepEqual(result.request.response_format, chat.parameters.response_format);
  assert.equal(result.request.service_tier, 'flex');
  assert.equal(result.request.truncation, 'auto');
  assert.deepEqual(result.request.include, ['reasoning.encrypted_content']);
  assert.equal(result.request.store, true);
  assert.equal(result.request.stream, true);

  console.log('✅ responses create parameters single-source regression passed');
}

main().catch((error) => {
  console.error('❌ responses create parameters single-source regression failed:', error);
  process.exit(1);
});
