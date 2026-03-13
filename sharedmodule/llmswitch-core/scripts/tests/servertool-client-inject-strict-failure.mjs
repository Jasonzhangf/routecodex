#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || 'assertion failed');
  }
}

function buildToolCallChat() {
  return {
    id: 'chatcmpl_continue_execution_strict_fail_1',
    object: 'chat.completion',
    model: 'gpt-5.3-codex',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_continue_execution_strict_fail_1',
              type: 'function',
              function: {
                name: 'continue_execution',
                arguments: JSON.stringify({
                  summary: '正在进行构建验证',
                  reason: 'progress_update'
                })
              }
            }
          ]
        },
        finish_reason: 'tool_calls'
      }
    ]
  };
}

async function main() {
  const { runServerToolOrchestration } = await import(path.resolve(repoRoot, 'dist/servertool/engine.js'));

  let capturedError = null;
  try {
    await runServerToolOrchestration({
      chat: buildToolCallChat(),
      adapterContext: {
        requestId: 'req_continue_execution_strict_fail_1',
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses',
        capturedChatRequest: {
          model: 'gpt-5.3-codex',
          messages: [{ role: 'user', content: '继续执行，不要停' }],
          tools: [],
          parameters: { stream: false },
          metadata: { originalEndpoint: '/v1/responses' }
        }
      },
      requestId: 'req_continue_execution_strict_fail_1',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      reenterPipeline: async () => {
        const error = new Error('clock client injection failed');
        error.code = 'SERVERTOOL_FOLLOWUP_FAILED';
        throw error;
      }
    });
  } catch (error) {
    capturedError = error;
  }

  assert(capturedError, 'clientInjectOnly flow should fail when reenterPipeline inject fails');
  const code = typeof capturedError.code === 'string' ? capturedError.code : '';
  assert(code === 'SERVERTOOL_FOLLOWUP_FAILED', `unexpected error code: ${String(code || capturedError.message)}`);

  console.log('✅ servertool client-inject strict failure regression passed');
}

main().catch((err) => {
  console.error('❌ servertool client-inject strict failure regression failed:', err);
  process.exit(1);
});
