#!/usr/bin/env node

import assert from 'node:assert/strict';
import path from 'node:path';

const projectRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
  '..',
);

async function main() {
  const { runServerSideToolEngine } = await import(
    path.join(projectRoot, 'dist', 'servertool', 'server-side-tools.js')
  );

  let followupArgs = null;
  const result = await runServerSideToolEngine({
    chatResponse: {
      id: 'chatcmpl_vision_auto',
      object: 'chat.completion',
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
    },
    adapterContext: {
      requestId: 'req_vision_auto_single_source',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      providerType: 'openai',
      modelId: 'gpt-4.1',
      capturedChatRequest: {
        model: 'gpt-4.1',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'input_image', image_url: 'data:image/png;base64,AAA' },
              { type: 'input_text', text: '请分析截图' }
            ]
          }
        ]
      }
    },
    requestId: 'req_vision_auto_single_source',
    entryEndpoint: '/v1/chat/completions',
    providerProtocol: 'openai-chat',
    reenterPipeline: async (args) => {
      followupArgs = args;
      return {
        body: {
          id: 'chatcmpl_vision_result',
          object: 'chat.completion',
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: 'vision summary'
              }
            }
          ]
        }
      };
    }
  });

  assert.equal(result.mode, 'tool_flow');
  assert.equal(result.execution?.flowId, 'vision_flow');
  assert.ok(followupArgs && typeof followupArgs === 'object');

  console.log('✅ vision auto captured-image single-source regression passed');
}

main().catch((error) => {
  console.error('❌ vision auto captured-image single-source regression failed:', error);
  process.exit(1);
});
