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
    id: 'chatcmpl_servertool_error_1',
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
              id: 'call_continue_execution_error_1',
              type: 'function',
              function: {
                name: 'continue_execution',
                arguments: JSON.stringify({ reason: 'missing summary should error' })
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

  let clientInjectArgs = null;
  let reenterCalled = false;
  const result = await runServerToolOrchestration({
    chat: buildToolCallChat(),
    adapterContext: {
      requestId: 'req_servertool_error_1',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      clientTmuxSessionId: 'tmux_req_servertool_error_1',
      tmuxSessionId: 'tmux_req_servertool_error_1',
      capturedChatRequest: {
        model: 'gpt-5.3-codex',
        messages: [{ role: 'user', content: 'continue exec error test' }],
        tools: [],
        parameters: { stream: false },
        metadata: { originalEndpoint: '/v1/responses' }
      }
    },
    requestId: 'req_servertool_error_1',
    entryEndpoint: '/v1/responses',
    providerProtocol: 'openai-responses',
    clientInjectDispatch: async (args) => {
      clientInjectArgs = args;
      return { ok: true };
    },
    reenterPipeline: async (args) => {
      reenterCalled = true;
      return { body: { choices: [] } };
    }
  });

  assert(result.executed === true, 'expected continue_execution to be handled');
  assert(result.flowId === 'continue_execution_flow', `unexpected flowId: ${String(result.flowId)}`);
  assert(reenterCalled === false, 'continue_execution without summary should not reenter');
  assert(clientInjectArgs && typeof clientInjectArgs === 'object', 'expected client inject followup args');
  const metadata =
    clientInjectArgs.metadata && typeof clientInjectArgs.metadata === 'object'
      ? clientInjectArgs.metadata
      : {};
  assert(metadata.clientInjectOnly === true, 'expected clientInjectOnly=true');
  assert(metadata.clientInjectText === '继续执行', `unexpected clientInjectText: ${String(metadata.clientInjectText)}`);
  assert(metadata.visibleSummary === '', `unexpected visibleSummary: ${String(metadata.visibleSummary)}`);

  console.log('✅ servertool continue_execution missing-summary regression passed');
}

main().catch((err) => {
  console.error('❌ servertool handler error followup regression failed:', err);
  process.exit(1);
});
