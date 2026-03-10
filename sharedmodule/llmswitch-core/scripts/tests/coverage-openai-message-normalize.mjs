#!/usr/bin/env node

import assert from 'node:assert/strict';

async function main() {
  const { normalizeChatRequest } = await import('../../dist/conversion/shared/openai-message-normalize.js');

  // Case 1: tool coercion + tool message normalization + empty assistant pruning.
  {
    process.env.RCC_DISABLE_SHELL_COERCE = '0';
    process.env.ROUTECODEX_MCP_ENABLE = '0';

    const req = {
      model: 'gpt-5.2',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'assistant', content: '   ' }, // should be dropped (no tool_calls + empty)
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: {
                name: 'rcc.shell',
                arguments: { command: 'echo hi && echo bye' }
              }
            }
          ]
        },
        { role: 'tool', tool_call_id: 'call_1', content: '' }
      ],
      tools: []
    };

    const out = normalizeChatRequest(req);
    assert.ok(Array.isArray(out.messages), 'messages must remain an array');
    assert.ok(out.messages.every((m) => m.role !== 'assistant' || m.content !== '   '), 'empty assistant turn should be pruned');

    const toolCall = out.messages.find((m) => m.role === 'assistant')?.tool_calls?.[0];
    assert.equal(toolCall.function.name, 'shell', 'dotted tool name must be normalized');
    const parsed = JSON.parse(toolCall.function.arguments);
    assert.ok(Array.isArray(parsed.command), 'shell command must be tokenized/coerced');
    assert.equal(parsed.command[0], 'bash', 'meta shell command should become bash -lc');

    const toolMsg = out.messages.find((m) => m.role === 'tool');
    assert.ok(toolMsg && typeof toolMsg.content === 'string' && toolMsg.content.length > 0, 'empty tool output must be normalized to text');
  }

  // Case 2: MCP tool injection (env servers + empty tools list).
  {
    process.env.ROUTECODEX_MCP_ENABLE = '1';
    process.env.RCC_MCP_SERVERS = 'context7';

    const out = normalizeChatRequest({
      model: 'gpt-5.2',
      messages: [{ role: 'user', content: 'hi' }],
      tools: []
    });
    assert.ok(Array.isArray(out.tools), 'tools must exist after MCP injection');
    const names = new Set(out.tools.map((t) => t?.function?.name).filter(Boolean));
    assert.ok(names.has('list_mcp_resources'), 'MCP list_mcp_resources must be injected');
    assert.ok(names.has('list_mcp_resource_templates'), 'MCP list_mcp_resource_templates must be injected');
  }

  console.log('✅ coverage-openai-message-normalize passed');
}

main().catch((e) => {
  console.error('❌ coverage-openai-message-normalize failed:', e);
  process.exit(1);
});

