import * as fs from 'node:fs';
import * as path from 'node:path';
import { runServerSideToolEngine } from '../../sharedmodule/llmswitch-core/src/servertool/server-side-tools.js';
import { runServerToolOrchestration } from '../../sharedmodule/llmswitch-core/src/servertool/engine.js';
import type { AdapterContext } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/json.js';

const TMP_DIR = path.join(process.cwd(), 'tmp', 'jest-exec-command-guard');

function makeCapturedChatRequest(): JsonObject {
  return {
    model: 'gpt-test',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [
      {
        type: 'function',
        function: { name: 'exec_command', description: 'exec', parameters: { type: 'object' } }
      },
      {
        type: 'function',
        function: { name: 'apply_patch', description: 'patch', parameters: { type: 'object' } }
      }
    ]
  } as JsonObject;
}

function makeToolCallResponse(args: Record<string, unknown>): JsonObject {
  return {
    id: 'chatcmpl-tool-1',
    object: 'chat.completion',
    model: 'gpt-test',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_exec_1',
              type: 'function',
              function: {
                name: 'exec_command',
                arguments: JSON.stringify(args)
              }
            }
          ]
        },
        finish_reason: 'tool_calls'
      }
    ]
  } as JsonObject;
}

describe('exec_command guard servertool (reenter)', () => {
  beforeAll(() => {
    fs.mkdirSync(TMP_DIR, { recursive: true });
  });

  test('does not fabricate tool_outputs or followups for exec_command (client executes tool)', async () => {
    const adapterContext: AdapterContext = {
      requestId: 'req-exec-guard-1',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      routeId: 'coding',
      capturedChatRequest: makeCapturedChatRequest(),
      execCommandGuard: { enabled: true, policyFile: path.join(TMP_DIR, 'missing.json') }
    } as any;

    const chatResponse = makeToolCallResponse({ cmd: 'rm -rf /', workdir: '/Users/fanzhang/Documents/github/routecodex' });

    const result = await runServerSideToolEngine({
      chatResponse,
      adapterContext,
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-exec-guard-1',
      providerProtocol: 'openai-chat',
      reenterPipeline: async () => ({ body: {} as JsonObject })
    });

    expect(result.mode).toBe('passthrough');
    expect(result.execution).toBeUndefined();
    const final = result.finalChatResponse as any;
    expect(final.tool_outputs).toBeUndefined();
    const tc = final?.choices?.[0]?.message?.tool_calls?.[0]?.function;
    expect(tc?.name).toBe('exec_command');
  });

  test('passthrough even when entry is /v1/responses', async () => {
    const adapterContext: AdapterContext = {
      requestId: 'req-exec-guard-resp-1',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-chat',
      routeId: 'coding',
      capturedChatRequest: makeCapturedChatRequest(),
      execCommandGuard: { enabled: true, policyFile: path.join(TMP_DIR, 'missing.json') }
    } as any;

    const chatResponse = makeToolCallResponse({ cmd: 'rm -rf /', workdir: '/Users/fanzhang/Documents/github/routecodex' });
    const result = await runServerSideToolEngine({
      chatResponse,
      adapterContext,
      entryEndpoint: '/v1/responses',
      requestId: 'req-exec-guard-resp-1',
      providerProtocol: 'openai-chat',
      reenterPipeline: async () => ({ body: {} as JsonObject })
    });

    expect(result.mode).toBe('passthrough');
    expect(result.execution).toBeUndefined();
  });

  test('allowed command passthrough when no rules match', async () => {
    const adapterContext: AdapterContext = {
      requestId: 'req-exec-guard-2',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      capturedChatRequest: makeCapturedChatRequest(),
      execCommandGuard: { enabled: true }
    } as any;

    const chatResponse = makeToolCallResponse({ cmd: 'echo hello', workdir: '/Users/fanzhang/Documents/github/routecodex' });
    const result = await runServerSideToolEngine({
      chatResponse,
      adapterContext,
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-exec-guard-2',
      providerProtocol: 'openai-chat',
      reenterPipeline: async () => ({ body: {} as JsonObject })
    });
    expect(result.mode).toBe('passthrough');
  });

  test('passthrough even when policy would have denied', async () => {
    const policyPath = path.join(TMP_DIR, 'policy.v1.json');
    fs.writeFileSync(
      policyPath,
      JSON.stringify({
        version: 1,
        defaults: { denyOutsideProjectDestructive: false, gitSingleFileOnly: false, denyMassKill: false },
        rules: [
          { id: 'deny-git-reset', type: 'regex', pattern: '\\bgit\\s+reset\\b', flags: 'i', reason: 'git reset is not allowed' }
        ]
      }),
      'utf8'
    );

    const adapterContext: AdapterContext = {
      requestId: 'req-exec-guard-3',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      capturedChatRequest: makeCapturedChatRequest(),
      execCommandGuard: { enabled: true, policyFile: policyPath }
    } as any;

    const chatResponse = makeToolCallResponse({ cmd: 'git reset --hard', workdir: '/Users/fanzhang/Documents/github/routecodex' });
    const result = await runServerSideToolEngine({
      chatResponse,
      adapterContext,
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-exec-guard-3',
      providerProtocol: 'openai-chat',
      reenterPipeline: async () => ({ body: {} as JsonObject })
    });

    expect(result.mode).toBe('passthrough');
    expect(result.execution).toBeUndefined();
  });

  test('orchestration does not call reenterPipeline (no server-side followup)', async () => {
    const adapterContext: AdapterContext = {
      requestId: 'req-exec-guard-4',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      routeId: 'coding',
      capturedChatRequest: makeCapturedChatRequest(),
      execCommandGuard: { enabled: true }
    } as any;

    const chatResponse = makeToolCallResponse({ cmd: 'rm -rf /', workdir: '/Users/fanzhang/Documents/github/routecodex' });

    let reenterCalled = false;
    const orchestration = await runServerToolOrchestration({
      chat: chatResponse,
      adapterContext,
      requestId: 'req-exec-guard-4',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      reenterPipeline: async (opts: any) => {
        reenterCalled = true;
        return {
          body: {
            id: 'chatcmpl-followup-1',
            object: 'chat.completion',
            model: 'gpt-test',
            choices: [{ index: 0, message: { role: 'assistant', content: 'blocked' }, finish_reason: 'stop' }]
          } as JsonObject
        };
      }
    });

    expect(reenterCalled).toBe(false);
    expect(orchestration.executed).toBe(false);
    expect((orchestration.chat as any)?.id).toBe('chatcmpl-tool-1');
  });
});
