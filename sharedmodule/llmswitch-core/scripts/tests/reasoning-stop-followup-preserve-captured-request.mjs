#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');

async function main() {
  const { prepareReasoningStopRequestTooling } = await import(
    path.resolve(
      repoRoot,
      'dist/conversion/hub/pipeline/hub-pipeline-chat-process-request-utils.js',
    )
  );

  const originalCaptured = {
    model: 'deepseek-v4-pro',
    messages: [{ role: 'user', content: '原始用户请求' }],
    tools: [
      {
        type: 'function',
        function: {
          name: 'exec_command',
          parameters: { type: 'object', properties: { cmd: { type: 'string' } } },
        },
      },
      {
        type: 'function',
        function: {
          name: 'write_stdin',
          parameters: { type: 'object', properties: { session_id: { type: 'number' } } },
        },
      },
    ],
    parameters: {
      parallel_tool_calls: true,
    },
  };

  const request = {
    model: 'deepseek-v4-pro',
    messages: [{ role: 'user', content: '继续执行，不要停止' }],
    tools: [
      {
        type: 'function',
        function: {
          name: 'reasoning.stop',
          parameters: { type: 'object', properties: { task_goal: { type: 'string' } } },
        },
      },
    ],
    parameters: {},
  };

  const adapterContext = {
    capturedChatRequest: JSON.parse(JSON.stringify(originalCaptured)),
    __rt: {
      serverToolFollowup: true,
    },
  };

  prepareReasoningStopRequestTooling({
    request,
    adapterContext,
  });

  assert.deepEqual(
    adapterContext.capturedChatRequest,
    originalCaptured,
    'serverTool followup reentry must preserve the original capturedChatRequest',
  );

  assert.deepEqual(request.messages, [
    { role: 'user', content: '继续执行，不要停止' },
  ]);

  assert.deepEqual(
    request.tools.map((tool) => tool?.function?.name),
    ['reasoning.stop'],
    'followup request itself may stay constrained, but must not overwrite capturedChatRequest',
  );

  const nonFollowupRequest = {
    model: 'deepseek-v4-pro',
    messages: [{ role: 'user', content: '检查日志' }],
    tools: [
      {
        type: 'function',
        function: {
          name: 'exec_command',
          parameters: { type: 'object', properties: { cmd: { type: 'string' } } },
        },
      },
    ],
    parameters: {
      parallel_tool_calls: true,
    },
  };
  const nonFollowupAdapterContext = {};

  prepareReasoningStopRequestTooling({
    request: nonFollowupRequest,
    adapterContext: nonFollowupAdapterContext,
  });

  assert.deepEqual(
    nonFollowupAdapterContext.capturedChatRequest.tools.map((tool) => tool?.function?.name),
    ['exec_command', 'reasoning.stop'],
    'non-followup entry should still capture current request and append reasoning.stop',
  );

  console.log(
    '✅ reasoning-stop followup preserve capturedChatRequest regression passed',
  );
}

main().catch((error) => {
  console.error(
    '❌ reasoning-stop followup preserve capturedChatRequest regression failed:',
    error,
  );
  process.exit(1);
});
