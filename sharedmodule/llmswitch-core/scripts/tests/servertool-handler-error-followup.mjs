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

  let reenterArgs = null;
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
    reenterPipeline: async (args) => {
      reenterArgs = args;
      return { body: { choices: [] } };
    }
  });

  assert(result.executed === true, 'expected servertool error to trigger tool_flow');
  assert(reenterArgs && typeof reenterArgs === 'object', 'expected followup args for failed servertool');

  const followupBody = reenterArgs.body;
  assert(followupBody && typeof followupBody === 'object', 'expected followup body');
  const messages = Array.isArray(followupBody.messages) ? followupBody.messages : [];
  const toolMessage = messages.find(
    (msg) =>
      msg &&
      typeof msg === 'object' &&
      msg.role === 'tool' &&
      typeof msg.content === 'string' &&
      msg.content.includes('continue_execution requires non-empty')
  );
  assert(toolMessage, 'expected error tool message in followup');
  let errorText = toolMessage.content;
  try {
    const parsed = JSON.parse(toolMessage.content);
    if (parsed && typeof parsed === 'object' && typeof parsed.message === 'string') {
      errorText = parsed.message;
    }
  } catch {
    // keep raw content
  }
  assert(
    errorText.includes('continue_execution requires non-empty "summary"'),
    'expected error message in followup tool message'
  );

  console.log('✅ servertool handler error followup regression passed');
}

main().catch((err) => {
  console.error('❌ servertool handler error followup regression failed:', err);
  process.exit(1);
});
