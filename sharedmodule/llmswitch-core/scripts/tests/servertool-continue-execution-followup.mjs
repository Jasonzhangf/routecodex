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
    id: 'chatcmpl_continue_execution_1',
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
              id: 'call_continue_execution_1',
              type: 'function',
              function: {
                name: 'continue_execution',
                arguments: JSON.stringify({ reason: 'I was about to summarize progress' })
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
  const { runHubChatProcess } = await import(path.resolve(repoRoot, 'dist/conversion/hub/process/chat-process.js'));
  const { runServerToolOrchestration } = await import(path.resolve(repoRoot, 'dist/servertool/engine.js'));

  const baseRequest = {
    model: 'gpt-5.3-codex',
    messages: [{ role: 'user', content: '继续写代码，不要停下来做总结' }],
    tools: [],
    parameters: { stream: true },
    metadata: { originalEndpoint: '/v1/responses' }
  };

  const processed = await runHubChatProcess({
    request: baseRequest,
    requestId: 'req_continue_inject_1',
    entryEndpoint: '/v1/responses',
    rawPayload: {},
    metadata: {
      requestId: 'req_continue_inject_1',
      providerProtocol: 'openai-responses'
    }
  });

  const processedRequest = processed.processedRequest;
  assert(processedRequest && typeof processedRequest === 'object', 'expected processed request');
  const toolNames = (Array.isArray(processedRequest.tools) ? processedRequest.tools : [])
    .map((tool) => tool?.function?.name)
    .filter((name) => typeof name === 'string');
  assert(toolNames.includes('continue_execution'), 'continue_execution tool should be injected in chat process');
  assert(processedRequest.metadata?.continueExecutionEnabled === true, 'continueExecutionEnabled metadata should be set');
  let followupArgs = null;
  let reenterCalled = false;
  const result = await runServerToolOrchestration({
    chat: buildToolCallChat(),
    adapterContext: {
      requestId: 'req_continue_execution_1',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      clientTmuxSessionId: 'tmux_req_continue_execution_1',
      tmuxSessionId: 'tmux_req_continue_execution_1',
      capturedChatRequest: processedRequest
    },
    requestId: 'req_continue_execution_1',
    entryEndpoint: '/v1/responses',
    providerProtocol: 'openai-responses',
    clientInjectDispatch: async (args) => {
      followupArgs = args;
      return { ok: true };
    },
    reenterPipeline: async (args) => {
      reenterCalled = true;
      return {
        body: {
          id: 'resp_continue_followup_1',
          object: 'response',
          model: 'gpt-5.3-codex',
          status: 'completed',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: '继续执行中' }]
            }
          ]
        }
      };
    }
  });

  assert(result.executed === true, 'expected continue_execution orchestration executed');
  assert(result.flowId === 'continue_execution_flow', `unexpected flowId: ${String(result.flowId)}`);
  assert(reenterCalled === false, 'continue_execution should use client inject dispatch only');
  assert(followupArgs && typeof followupArgs === 'object', 'expected captured followup args');
  assert(
    typeof followupArgs.requestId === 'string' && followupArgs.requestId.endsWith(':continue_execution_followup'),
    `expected followup requestId suffix, got: ${String(followupArgs.requestId)}`
  );

  const followupBody = followupArgs.body;
  assert(followupBody && typeof followupBody === 'object', 'expected followup body');
  const followupToolNames = (Array.isArray(followupBody.tools) ? followupBody.tools : [])
    .map((tool) => tool?.function?.name)
    .filter((name) => typeof name === 'string');
  assert(followupToolNames.includes('continue_execution'), 'followup should keep continue_execution tool in tool list');

  const metadata = followupArgs.metadata && typeof followupArgs.metadata === 'object' ? followupArgs.metadata : {};
  const runtime = metadata.__rt && typeof metadata.__rt === 'object' ? metadata.__rt : metadata;
  assert(metadata.stream === false, 'followup should be non-streaming');
  assert(!Object.prototype.hasOwnProperty.call(metadata, 'routeHint'), 'followup should not carry metadata.routeHint legacy field');
  assert(runtime.serverToolFollowup === true, 'followup metadata should mark serverToolFollowup=true');
  assert(metadata.clientInjectOnly === true, 'continue_execution followup should use clientInjectOnly mode');
  assert(metadata.clientInjectText === '继续执行', 'continue_execution followup should inject fixed continue text');

  console.log('✅ servertool continue_execution followup regression passed');
}

main().catch((err) => {
  console.error('❌ servertool continue_execution followup regression failed:', err);
  process.exit(1);
});
