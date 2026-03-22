#!/usr/bin/env node

import assert from 'node:assert/strict';

async function main() {
  const {
    buildChatResponseFromResponses,
    collectToolCallsFromResponses,
    resolveFinishReason
  } = await import('../../dist/conversion/shared/responses-response-utils.js');

  {
    const response = {
      id: 'resp_cov_1',
      object: 'response',
      model: 'gpt-test',
      created: 1700000000,
      usage: { total_tokens: 12 },
      output_text: 'hello',
      output: [
        {
          type: 'reasoning',
          content: [{ text: '<think>hidden</think>plan' }],
          summary: [{ text: 'summary' }],
          encrypted_content: 'enc'
        },
        {
          type: 'function_call',
          id: 'call_abc',
          name: 'shell_command',
          arguments: { cmd: 'pwd' }
        }
      ]
    };

    const toolCalls = collectToolCallsFromResponses(response);
    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0].function?.name, 'exec_command');

    const finishReason = resolveFinishReason(response, toolCalls);
    assert.equal(finishReason, 'tool_calls');

    const chat = buildChatResponseFromResponses(response);
    assert.equal(chat.object, 'chat.completion');
    assert.equal(chat.id, 'resp_cov_1');
    assert.equal(chat.choices[0].message.content, 'hello');
    assert.equal(chat.choices[0].message.reasoning_content, 'plan');
    assert.equal(chat.choices[0].message.tool_calls[0].function.name, 'exec_command');
    if (chat.__responses_reasoning && typeof chat.__responses_reasoning === 'object') {
      assert.equal(chat.__responses_reasoning.encrypted_content, 'enc');
    }
    assert.equal(chat.__responses_output_text_meta.hasField, true);
    assert.ok(chat.__responses_payload_snapshot);
  }

  {
    const passthrough = { choices: [{ message: { role: 'assistant', content: 'ok' } }] };
    assert.equal(buildChatResponseFromResponses(passthrough), passthrough);
  }

  console.log('✅ coverage-responses-response-utils passed');
}

main().catch((error) => {
  console.error('❌ coverage-responses-response-utils failed:', error);
  process.exit(1);
});
