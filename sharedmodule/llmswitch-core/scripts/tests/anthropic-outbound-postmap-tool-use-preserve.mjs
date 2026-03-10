#!/usr/bin/env node

import assert from 'node:assert/strict';

async function main() {
  const { applyHubOperationTableOutboundPostMap } = await import('../../dist/conversion/hub/operation-table/operation-table-runner.js');

  const chatEnvelope = {
    messages: [
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'exec_command', arguments: '{"cmd":"echo hi"}' }
          }
        ]
      },
      {
        role: 'tool',
        tool_call_id: 'call_1',
        content: 'ok'
      }
    ],
    metadata: { context: { requestId: 'req_test' } },
    toolOutputs: [
      {
        tool_call_id: 'call_1',
        content: 'ok'
      }
    ]
  };

  const formatEnvelope = {
    protocol: 'anthropic-messages',
    direction: 'request',
    payload: {
      model: 'qwen3-coder-next-mlx',
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'call_1',
              name: 'exec_command',
              input: { cmd: 'echo hi' }
            }
          ]
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call_1',
              content: 'ok'
            }
          ]
        }
      ]
    }
  };

  applyHubOperationTableOutboundPostMap({
    chatEnvelope,
    formatEnvelope,
    adapterContext: {
      requestId: 'req_test',
      providerProtocol: 'anthropic-messages',
      providerId: 'lmstudio',
      entryEndpoint: '/v1/responses'
    }
  });

  const assistant = formatEnvelope.payload.messages[0];
  const toolResult = formatEnvelope.payload.messages[1];
  assert.equal(assistant.role, 'assistant');
  assert.ok(Array.isArray(assistant.content), 'assistant content should remain structured blocks');
  assert.equal(assistant.content[0]?.type, 'tool_use');
  assert.equal(assistant.content[0]?.id, 'call_1');

  assert.equal(toolResult.role, 'user');
  assert.ok(Array.isArray(toolResult.content), 'tool result should remain structured blocks');
  assert.equal(toolResult.content[0]?.type, 'tool_result');
  assert.equal(toolResult.content[0]?.tool_use_id, 'call_1');

  console.log('✅ anthropic-outbound-postmap-tool-use-preserve passed');
}

main().catch((error) => {
  console.error('❌ anthropic-outbound-postmap-tool-use-preserve failed:', error);
  process.exit(1);
});
