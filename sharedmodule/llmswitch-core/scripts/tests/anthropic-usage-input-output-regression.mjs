#!/usr/bin/env node

import assert from 'node:assert/strict';
import { buildAnthropicResponseFromChat } from '../../dist/conversion/hub/response/response-runtime.js';

function testInputOutputUsageMapping() {
  const chatPayload = {
    id: 'chatcmpl_usage_input_output_only',
    object: 'chat.completion',
    created: 1,
    model: 'deepseek-reasoner',
    usage: {
      input_tokens: 204471,
      output_tokens: 33
    },
    choices: [
      {
        index: 0,
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_123',
              type: 'function',
              function: {
                name: 'edit',
                arguments: '{"file_path":"server.js"}'
              }
            }
          ]
        }
      }
    ]
  };

  const mapped = buildAnthropicResponseFromChat(chatPayload, {
    model: 'deepseek-reasoner'
  });

  assert.equal(mapped?.usage?.input_tokens, 204471, 'anthropic input_tokens should preserve usage.input_tokens');
  assert.equal(mapped?.usage?.output_tokens, 33, 'anthropic output_tokens should preserve usage.output_tokens');
  assert.equal(mapped?.stop_reason, 'tool_use', 'tool_calls finish_reason should map to tool_use');
}

function testPromptCompletionFallback() {
  const chatPayload = {
    id: 'chatcmpl_usage_prompt_completion',
    object: 'chat.completion',
    created: 1,
    model: 'glm-4.6',
    usage: {
      prompt_tokens: 120,
      completion_tokens: 8
    },
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: {
          role: 'assistant',
          content: 'ok'
        }
      }
    ]
  };

  const mapped = buildAnthropicResponseFromChat(chatPayload, {
    model: 'glm-4.6'
  });

  assert.equal(mapped?.usage?.input_tokens, 120, 'anthropic input_tokens should fallback to prompt_tokens');
  assert.equal(mapped?.usage?.output_tokens, 8, 'anthropic output_tokens should fallback to completion_tokens');
}

function main() {
  testInputOutputUsageMapping();
  testPromptCompletionFallback();
  console.log('[matrix:anthropic-usage-input-output-regression] ok');
}

main();
