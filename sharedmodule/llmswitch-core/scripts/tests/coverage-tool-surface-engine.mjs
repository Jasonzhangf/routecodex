#!/usr/bin/env node

import assert from 'node:assert/strict';

async function main() {
  const { applyProviderOutboundToolSurface } = await import(
    '../../dist/conversion/hub/tool-surface/tool-surface-engine.js'
  );

  const stageEvents = [];
  const stageRecorder = {
    record(stage, data) {
      stageEvents.push({ stage, data });
    }
  };

  // 1) Tool definition conversion: OpenAI tools on gemini-chat (enforce => gemini tools)
  {
    const payload = {
      model: 'gpt-5.2',
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'web_search',
            description: 'search',
            parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
          }
        }
      ]
    };

    const out = applyProviderOutboundToolSurface({
      config: { mode: 'enforce', sampleRate: 1 },
      providerProtocol: 'gemini-chat',
      payload,
      stageRecorder,
      requestId: 'req_toolsurface_gemini'
    });
    assert.ok(Array.isArray(out.tools), 'tools must exist');
    const first = out.tools[0];
    assert.ok(first && typeof first === 'object', 'gemini tools must be object entries');
    // gemini tools should be in { functionDeclarations: [...] } form
    assert.ok(Array.isArray(first.functionDeclarations), 'expected gemini functionDeclarations');
    assert.equal(first.functionDeclarations[0]?.name, 'web_search');
  }

  // 2) History carrier normalization: messages -> input for openai-responses (enforce)
  {
    const payload = {
      model: 'gpt-5.2',
      messages: [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'web_search', arguments: '{"query":"x"}' } }]
        },
        { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' }
      ],
      tools: [
        { type: 'function', function: { name: 'web_search', parameters: { type: 'object', properties: { query: { type: 'string' } } } } }
      ]
    };

    const out = applyProviderOutboundToolSurface({
      config: { mode: 'enforce', sampleRate: 1 },
      providerProtocol: 'openai-responses',
      payload,
      stageRecorder,
      requestId: 'req_toolsurface_responses'
    });

    assert.ok(Array.isArray(out.input), 'openai-responses must carry history in input[]');
    assert.ok(!Array.isArray(out.messages), 'messages must be removed/undefined when normalized to input[]');
  }

  // 3) History carrier normalization: input -> messages for openai-chat (enforce)
  {
    const payload = {
      model: 'gpt-5.2',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }]
    };

    const out = applyProviderOutboundToolSurface({
      config: { mode: 'enforce', sampleRate: 1 },
      providerProtocol: 'openai-chat',
      payload,
      stageRecorder,
      requestId: 'req_toolsurface_chat'
    });

    assert.ok(Array.isArray(out.messages), 'openai-chat must carry history in messages[]');
    assert.ok(!Array.isArray(out.input), 'input must be removed/undefined when normalized to messages[]');
  }

  // Smoke: stage recorder should have observed at least one diff event.
  assert.ok(stageEvents.length > 0);

  console.log('✅ coverage-tool-surface-engine passed');
}

main().catch((e) => {
  console.error('❌ coverage-tool-surface-engine failed:', e);
  process.exit(1);
});

