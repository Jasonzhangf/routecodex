#!/usr/bin/env node

import assert from 'node:assert/strict';

async function main() {
  const { buildAnthropicRequestFromOpenAIChat } = await import('../../dist/conversion/codecs/anthropic-openai-codec.js');

  const input = {
    model: 'qwen3-coder-next-mlx',
    messages: [
      { role: 'user', content: 'run command' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: '247508672',
            type: 'function',
            function: {
              name: 'exec_command',
              arguments: '{"cmd":"echo hi"}'
            }
          }
        ]
      },
      {
        role: 'tool',
        tool_call_id: '247508672',
        content: 'ok'
      }
    ],
    __anthropicMirror: {
      messageContentShape: ['string', 'string', 'array']
    }
  };

  const output = buildAnthropicRequestFromOpenAIChat(input);
  assert.ok(Array.isArray(output.messages), 'messages should be array');

  const assistantIndex = output.messages.findIndex((entry) =>
    entry &&
    entry.role === 'assistant' &&
    Array.isArray(entry.content) &&
    entry.content.some((block) => block && block.type === 'tool_use' && block.id === '247508672')
  );
  assert.ok(assistantIndex >= 0, 'assistant tool_use should be preserved even when mirror shape is string');

  const toolResultIndex = output.messages.findIndex((entry) =>
    entry &&
    entry.role === 'user' &&
    Array.isArray(entry.content) &&
    entry.content.some((block) => block && block.type === 'tool_result' && block.tool_use_id === '247508672')
  );
  assert.ok(toolResultIndex > assistantIndex, 'tool_result should appear after tool_use');
  assert.equal(toolResultIndex, assistantIndex + 1, 'tool_result must immediately follow assistant tool_use');

  console.log('✅ anthropic-tool-use-mirror-shape-regression passed');
}

main().catch((error) => {
  console.error('❌ anthropic-tool-use-mirror-shape-regression failed:', error);
  process.exit(1);
});
