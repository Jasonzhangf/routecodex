#!/usr/bin/env node

import assert from 'node:assert/strict';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

async function importModule(relativePath) {
  return import(path.resolve(repoRoot, 'dist', relativePath));
}

async function main() {
  const { buildResponsesRequestFromChat } = await importModule('conversion/responses/responses-openai-bridge.js');

  // Route-selected style must override captured context to prevent cross-provider leakage:
  // LM Studio "preserve" must not contaminate OpenAI `/v1/responses` which requires `fc_*` ids.
  {
    const chat = {
      model: 'gpt-5.2',
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_ABC123',
              type: 'function',
              function: { name: 'exec_command', arguments: JSON.stringify({ cmd: 'echo hi' }) }
            }
          ]
        },
        {
          role: 'tool',
          tool_call_id: 'call_ABC123',
          content: 'ok'
        }
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'exec_command',
            description: 'Run a shell command',
            parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] }
          }
        }
      ],
      metadata: { toolCallIdStyle: 'fc' }
    };

    const ctx = {
      requestId: 'req_test',
      toolCallIdStyle: 'preserve',
      metadata: { toolCallIdStyle: 'preserve' }
    };

    const out = buildResponsesRequestFromChat(chat, ctx);
    assert.ok(out && typeof out === 'object' && out.request, 'expected buildResponsesRequestFromChat result');
    assert.ok(Array.isArray(out.request.input), 'expected Responses input array');
    for (const [idx, item] of out.request.input.entries()) {
      if (!item || typeof item !== 'object') continue;
      assert.equal(
        'tool_call_id' in item,
        false,
        `expected out.request.input[${idx}] to not contain tool_call_id`
      );
    }
    const functionCall = out.request.input.find((it) => it && typeof it === 'object' && it.type === 'function_call');
    assert.ok(functionCall, 'expected function_call item');
    assert.ok(
      typeof functionCall.id === 'string' && functionCall.id.startsWith('fc_'),
      `expected function_call.id to start with fc_ (got ${String(functionCall.id)})`
    );
    assert.ok(
      typeof functionCall.call_id === 'string' && functionCall.call_id.startsWith('call_'),
      `expected function_call.call_id to start with call_ (got ${String(functionCall.call_id)})`
    );
    assert.equal(functionCall.call_id, 'call_ABC123', 'expected call_id preserved');
    assert.equal(functionCall.id, 'fc_ABC123', 'expected id normalized to fc_* based on call_id');

    const toolOutput = out.request.input.find((it) => it && typeof it === 'object' && it.type === 'function_call_output');
    assert.ok(toolOutput, 'expected function_call_output item');
    assert.equal(toolOutput.call_id, 'call_ABC123', 'expected tool output call_id');
    assert.equal(toolOutput.id, 'fc_ABC123', 'expected tool output id normalized to fc_* based on call_id');
  }

  // Oversized tool_call ids from upstream history must be compacted to OpenAI Responses limits.
  {
    const longRawId = `functions.call_${'a'.repeat(240)}:40`;
    const chat = {
      model: 'gpt-5.2',
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: longRawId,
              type: 'function',
              function: { name: 'exec_command', arguments: JSON.stringify({ cmd: 'pwd' }) }
            }
          ]
        },
        {
          role: 'tool',
          tool_call_id: longRawId,
          content: 'ok'
        }
      ],
      metadata: { toolCallIdStyle: 'fc' }
    };

    const out = buildResponsesRequestFromChat(chat, { requestId: 'req_long_id' });
    assert.ok(Array.isArray(out.request.input), 'expected Responses input array');

    const functionCall = out.request.input.find((it) => it && typeof it === 'object' && it.type === 'function_call');
    assert.ok(functionCall, 'expected function_call item');
    assert.ok(String(functionCall.call_id).startsWith('call_'), 'expected compacted call_id with call_ prefix');
    assert.ok(String(functionCall.id).startsWith('fc_'), 'expected compacted function_call id with fc_ prefix');
    assert.ok(String(functionCall.call_id).length <= 64, 'expected function_call.call_id length <= 64');
    assert.ok(String(functionCall.id).length <= 64, 'expected function_call.id length <= 64');

    const toolOutput = out.request.input.find((it) => it && typeof it === 'object' && it.type === 'function_call_output');
    assert.ok(toolOutput, 'expected function_call_output item');
    assert.equal(toolOutput.call_id, functionCall.call_id, 'expected output call_id linked with function_call');
    assert.ok(String(toolOutput.id).startsWith('fc_'), 'expected compacted output id with fc_ prefix');
    assert.ok(String(toolOutput.id).length <= 64, 'expected function_call_output.id length <= 64');
  }

  // Oversized history input item ids must be compacted to <=64 before outbound request.
  {
    const longHistoryId = `msg_${'x'.repeat(240)}:stop_followup`;
    const chat = {
      model: 'gpt-5.2',
      messages: [
        { role: 'user', content: 'continue' }
      ],
      metadata: { toolCallIdStyle: 'fc' }
    };

    const out = buildResponsesRequestFromChat(
      chat,
      { requestId: 'req_long_history_id' },
      {
        bridgeHistory: {
          input: [
            {
              type: 'message',
              id: longHistoryId,
              role: 'assistant',
              content: [{ type: 'output_text', text: 'previous step' }]
            }
          ],
          originalSystemMessages: []
        }
      }
    );

    assert.ok(Array.isArray(out.request.input), 'expected Responses input array');
    const historyMessage = out.request.input.find(
      (it) =>
        it &&
        typeof it === 'object' &&
        typeof it.id === 'string' &&
        Array.isArray(it.content) &&
        it.content.some((part) => part && typeof part === 'object' && part.text === 'previous step')
    );
    assert.ok(historyMessage, 'expected preserved history message item');
    assert.ok(String(historyMessage.id).length <= 64, 'expected history message id length <= 64');
    assert.notEqual(String(historyMessage.id), longHistoryId, 'expected oversized history id to be compacted');
  }

  // For LM Studio targets, route-selected preserve must win (keep call_* ids).
  {
    const chat = {
      model: 'local-model',
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_keep_me',
              type: 'function',
              function: { name: 'exec_command', arguments: JSON.stringify({ cmd: 'echo hi' }) }
            }
          ]
        }
      ],
      metadata: { toolCallIdStyle: 'preserve' }
    };

    const ctx = {
      requestId: 'req_test2',
      toolCallIdStyle: 'fc',
      metadata: { toolCallIdStyle: 'fc' }
    };

    const out = buildResponsesRequestFromChat(chat, ctx);
    assert.ok(Array.isArray(out.request.input), 'expected Responses input array');
    const functionCall = out.request.input.find((it) => it && typeof it === 'object' && it.type === 'function_call');
    assert.ok(functionCall, 'expected function_call item');
    assert.equal(functionCall.id, 'call_keep_me');
    assert.equal(functionCall.call_id, 'call_keep_me');
  }

  console.log('✅ responses-tool-call-id-style-route-wins passed');
}

main().catch((e) => {
  console.error('❌ responses-tool-call-id-style-route-wins failed:', e);
  process.exit(1);
});
