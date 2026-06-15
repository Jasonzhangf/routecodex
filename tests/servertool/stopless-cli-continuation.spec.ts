import { describe, expect, jest, test } from '@jest/globals';

import { runServerToolOrchestration } from '../../sharedmodule/llmswitch-core/src/servertool/engine.js';
import { resolveStateKey } from '../../sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto/runtime-utils.js';
import type { AdapterContext } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/json.js';

function buildStopChatResponse(content: string = 'need continue'): JsonObject {
  return {
    id: 'chatcmpl-stopless-cli',
    object: 'chat.completion',
    model: 'gpt-test',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop'
      }
    ]
  } as JsonObject;
}

function buildAdapterContext(overrides: Partial<AdapterContext> = {}): AdapterContext {
  const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return {
    requestId: overrides.requestId ?? `req-stopless-cli-${unique}`,
    entryEndpoint: overrides.entryEndpoint ?? '/v1/chat/completions',
    providerProtocol: overrides.providerProtocol ?? 'openai-chat',
    sessionId: overrides.sessionId ?? `session-stopless-cli-${unique}`,
    capturedChatRequest: overrides.capturedChatRequest ?? {
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'diagnose this' }]
    }
  } as any;
}

function extractExecCommand(resultChat: any): string {
  const toolCall = resultChat?.choices?.[0]?.message?.tool_calls?.[0];
  expect(toolCall?.function?.name).toBe('exec_command');
  return JSON.parse(toolCall.function.arguments).cmd;
}

describe('stopless CLI continuation', () => {
  test('resolveStateKey still uses only sessionId (no tmux/conversation/inject fallback)', () => {
    expect(resolveStateKey({
      providerProtocol: 'openai-responses',
      requestId: 'req-stopless-session-only',
      sessionId: 'session-a',
      conversationId: 'conversation-ignored',
      clientTmuxSessionId: 'tmux-ignored',
      stopMessageClientInjectScope: 'conversation:legacy'
    })).toBe('session:session-a');
  });

  test('stopless projects CLI and never reenters pipeline', async () => {
    const reenterPipeline = jest.fn(async () => ({
      body: {
        id: 'chatcmpl-should-not-run',
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: 'unexpected' }, finish_reason: 'stop' }]
      } as JsonObject
    }));
    const adapterContext = buildAdapterContext();

    const result = await runServerToolOrchestration({
      chat: buildStopChatResponse('need more evidence'),
      adapterContext,
      requestId: adapterContext.requestId,
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      reenterPipeline
    });

    expect(result.executed).toBe(true);
    expect(result.flowId).toBe('stop_message_flow');
    expect(reenterPipeline).not.toHaveBeenCalled();
    const command = extractExecCommand(result.chat);
    expect(command).toMatch(/^routecodex hook run stop_message_auto --input-json '/);
  });

  test('stopless CLI command is status-only and does not leak continuation prompt text', async () => {
    const adapterContext = buildAdapterContext();

    const result = await runServerToolOrchestration({
      chat: buildStopChatResponse('阶段完成，但还需继续执行'),
      adapterContext,
      requestId: adapterContext.requestId,
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      reenterPipeline: async () => {
        throw new Error('stopless CLI projection must not reenter');
      }
    });

    const command = extractExecCommand(result.chat);
    const input = JSON.parse(command.match(/--input-json '(.+)'$/)?.[1] ?? '{}');
    expect(input).toMatchObject({
      flowId: 'stop_message_flow'
    });
    expect(typeof input.repeatCount).toBe('number');
    expect(typeof input.maxRepeats).toBe('number');
    expect(input.continuationPrompt).toBeUndefined();
    expect(input.schemaGuidance).toBeUndefined();
    expect(command).not.toContain('continuationPrompt');
    expect(command).not.toContain('schemaGuidance');
    expect(command).not.toContain('第一轮核对');
    expect(command).not.toContain('stop schema');
  });

  test('terminal stopless result stays terminal and does not project CLI', async () => {
    const adapterContext = buildAdapterContext({
      __raw_request_body: {
        model: 'gpt-test',
        input: [{ role: 'user', content: [{ type: 'input_text', text: '继续执行' }] }]
      } as any
    });

    const result = await runServerToolOrchestration({
      chat: {
        id: 'chatcmpl-stopless-cli-terminal',
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: [
                '已完成在线验证。',
                '{"stopreason":0,"reason":"done","has_evidence":1,"evidence":"live probe","issue_cause":"none","excluded_factors":"none","diagnostic_order":"single round","done_steps":"verified","next_step":"","next_suggested_path":"","needs_user_input":false,"learned":"ok"}'
              ].join('\n')
            },
            finish_reason: 'stop'
          }
        ]
      } as any,
      adapterContext,
      requestId: adapterContext.requestId,
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      reenterPipeline: async () => {
        throw new Error('terminal stopless result must not reenter');
      }
    });

    const visible = JSON.stringify(result.chat);
    expect(visible).not.toContain('routecodex hook run stop_message_auto');
    expect(visible).not.toContain('exec_command');
  });
});
