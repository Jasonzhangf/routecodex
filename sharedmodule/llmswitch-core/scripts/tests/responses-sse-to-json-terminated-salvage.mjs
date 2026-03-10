#!/usr/bin/env node

import assert from 'node:assert/strict';

async function* terminatedSseStream() {
  const response = {
    id: 'resp_lmstudio_1',
    object: 'response',
    created: Date.now(),
    status: 'in_progress',
    model: 'qwen3-coder-next-mlx'
  };

  yield `event: response.created\ndata: ${JSON.stringify({ response, type: 'response.created', sequence_number: 1 })}\n\n`;

  yield `event: response.output_item.added\ndata: ${JSON.stringify({
    type: 'response.output_item.added',
    sequence_number: 2,
    output_index: 0,
    item_id: 'fc_1',
    item: {
      id: 'fc_1',
      type: 'function_call',
      status: 'in_progress',
      call_id: 'call_1',
      name: 'exec_command',
      arguments: ''
    }
  })}\n\n`;

  yield `event: response.function_call_arguments.done\ndata: ${JSON.stringify({
    type: 'response.function_call_arguments.done',
    sequence_number: 3,
    item_id: 'fc_1',
    output_index: 0,
    call_id: 'call_1',
    name: 'exec_command',
    arguments: JSON.stringify({ command: 'echo ok', workdir: '/' })
  })}\n\n`;

  yield `event: response.output_item.done\ndata: ${JSON.stringify({
    type: 'response.output_item.done',
    sequence_number: 4,
    item_id: 'fc_1',
    output_index: 0,
    item: {
      id: 'fc_1',
      type: 'function_call',
      status: 'completed',
      call_id: 'call_1',
      name: 'exec_command'
    }
  })}\n\n`;

  throw new Error('terminated');
}

async function main() {
  const { ResponsesSseToJsonConverter } = await import('../../dist/sse/sse-to-json/index.js');

  const converter = new ResponsesSseToJsonConverter();

  const result = await converter.convertSseToJson(terminatedSseStream(), {
    requestId: 'terminated-salvage',
    model: 'qwen3-coder-next-mlx'
  });

  assert.equal(result.object, 'response');
  assert.equal(result.id, 'resp_lmstudio_1');
  assert.equal(result.status, 'completed');
  assert.ok(Array.isArray(result.output));
  assert.equal(result.output.length, 1);
  assert.equal(result.output[0].type, 'function_call');
  assert.equal(result.output[0].name, 'exec_command');
  assert.equal(result.output[0].call_id, 'call_1');
  assert.equal(typeof result.output[0].arguments, 'string');

  async function* terminatedWithOrphanCalls() {
    const response = {
      id: 'resp_lmstudio_orphan',
      object: 'response',
      created: Date.now(),
      status: 'in_progress',
      model: 'qwen3-coder-next-mlx'
    };

    yield `event: response.created\ndata: ${JSON.stringify({ response, type: 'response.created', sequence_number: 1 })}\n\n`;
    yield `event: response.output_item.added\ndata: ${JSON.stringify({
      type: 'response.output_item.added',
      sequence_number: 2,
      output_index: 0,
      item_id: 'fc_ok',
      item: { id: 'fc_ok', type: 'function_call', status: 'in_progress', call_id: 'call_ok', name: 'exec_command', arguments: '' }
    })}\n\n`;
    yield `event: response.function_call_arguments.done\ndata: ${JSON.stringify({
      type: 'response.function_call_arguments.done',
      sequence_number: 3,
      item_id: 'fc_ok',
      output_index: 0,
      call_id: 'call_ok',
      name: 'exec_command',
      arguments: JSON.stringify({ command: 'echo ok' })
    })}\n\n`;
    yield `event: response.output_item.done\ndata: ${JSON.stringify({
      type: 'response.output_item.done',
      sequence_number: 4,
      item_id: 'fc_ok',
      output_index: 0,
      item: { id: 'fc_ok', type: 'function_call', status: 'completed', call_id: 'call_ok', name: 'exec_command' }
    })}\n\n`;

    yield `event: response.output_item.added\ndata: ${JSON.stringify({
      type: 'response.output_item.added',
      sequence_number: 5,
      output_index: 1,
      item_id: 'fc_orphan_1',
      item: { id: 'fc_orphan_1', type: 'function_call', status: 'in_progress', call_id: 'call_orphan_1', name: 'exec_command', arguments: '' }
    })}\n\n`;
    yield `event: response.output_item.added\ndata: ${JSON.stringify({
      type: 'response.output_item.added',
      sequence_number: 6,
      output_index: 2,
      item_id: 'fc_orphan_2',
      item: { id: 'fc_orphan_2', type: 'function_call', status: 'in_progress', call_id: 'call_orphan_2', name: 'exec_command', arguments: '' }
    })}\n\n`;

    throw new Error('terminated');
  }

  const result2 = await converter.convertSseToJson(terminatedWithOrphanCalls(), {
    requestId: 'terminated-salvage-orphan-calls',
    model: 'qwen3-coder-next-mlx'
  });

  assert.equal(result2.status, 'completed');
  const functionCalls = (result2.output || []).filter((entry) => entry && entry.type === 'function_call');
  assert.equal(functionCalls.length, 1);
  assert.equal(functionCalls[0].call_id, 'call_ok');

  async function* terminatedWithIdleTimeout() {
    const response = {
      id: 'resp_lmstudio_idle_timeout',
      object: 'response',
      created: Date.now(),
      status: 'in_progress',
      model: 'qwen3-coder-next-mlx'
    };

    yield `event: response.created\ndata: ${JSON.stringify({ response, type: 'response.created', sequence_number: 1 })}\n\n`;
    yield `event: response.output_item.added\ndata: ${JSON.stringify({
      type: 'response.output_item.added',
      sequence_number: 2,
      output_index: 0,
      item_id: 'fc_idle',
      item: { id: 'fc_idle', type: 'function_call', status: 'in_progress', call_id: 'call_idle', name: 'exec_command', arguments: '' }
    })}\n\n`;
    yield `event: response.function_call_arguments.done\ndata: ${JSON.stringify({
      type: 'response.function_call_arguments.done',
      sequence_number: 3,
      item_id: 'fc_idle',
      output_index: 0,
      call_id: 'call_idle',
      name: 'exec_command',
      arguments: JSON.stringify({ command: 'echo idle timeout salvage' })
    })}\n\n`;
    yield `event: response.output_item.done\ndata: ${JSON.stringify({
      type: 'response.output_item.done',
      sequence_number: 4,
      item_id: 'fc_idle',
      output_index: 0,
      item: { id: 'fc_idle', type: 'function_call', status: 'completed', call_id: 'call_idle', name: 'exec_command' }
    })}\n\n`;

    throw new Error('UPSTREAM_STREAM_IDLE_TIMEOUT');
  }

  const result3 = await converter.convertSseToJson(terminatedWithIdleTimeout(), {
    requestId: 'terminated-salvage-idle-timeout',
    model: 'qwen3-coder-next-mlx'
  });

  assert.equal(result3.status, 'completed');
  assert.ok(Array.isArray(result3.output));
  assert.equal(result3.output.length, 1);
  assert.equal(result3.output[0].type, 'function_call');
  assert.equal(result3.output[0].call_id, 'call_idle');

  console.log('✅ responses-sse-to-json-terminated-salvage passed');
}

main().catch((e) => {
  console.error('❌ responses-sse-to-json-terminated-salvage failed:', e);
  process.exit(1);
});
