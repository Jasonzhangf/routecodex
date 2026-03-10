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
      parallel_tool_calls: true
    },
    metadata: {
      extraFields: {
        tool_choice: 'auto',
        parallel_tool_calls: false
      }
    }
  };

  const context = {
    requestId: 'req_tool_choice_single_source',
    toolChoice: 'auto',
    parallelToolCalls: false,
    parameters: {
      tool_choice: 'none',
      parallel_tool_calls: false
    },
    metadata: {
      extraFields: {
        tool_choice: 'auto',
        parallel_tool_calls: false,
        parameters: {
          tool_choice: 'none',
          parallel_tool_calls: false
        }
      }
    }
  };

  const result = mod.buildResponsesRequestFromChat(chat, context);
  assert.equal(result.request.tool_choice, 'required');
  assert.equal(result.request.parallel_tool_calls, true);

  console.log('✅ responses tool_choice/parallel_tool_calls single-source regression passed');
}

main().catch((error) => {
  console.error('❌ responses tool_choice/parallel_tool_calls single-source regression failed:', error);
  process.exit(1);
});
