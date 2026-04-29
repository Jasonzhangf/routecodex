import { jest } from '@jest/globals';
import { runServerSideToolEngine } from '../../sharedmodule/llmswitch-core/src/servertool/server-side-tools.js';
import { runServerToolOrchestration } from '../../sharedmodule/llmswitch-core/src/servertool/engine.js';
import type { AdapterContext } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/json.js';

function buildReasoningOnlyResponse(): JsonObject {
  return {
    id: 'chatcmpl_reasoning_only',
    object: 'chat.completion',
    model: 'gpt-test',
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: {
          role: 'assistant',
          content: '',
          reasoning_content: 'Investigating headless mode mismatch'
        }
      }
    ]
  };
}

describe('servertool reasoning-only auto continue', () => {
  test('uses reenter followup when tmux session is unavailable', async () => {
    const chatResponse = buildReasoningOnlyResponse();
    const adapterContext = {} as AdapterContext;
    const result = await runServerSideToolEngine({
      chatResponse,
      adapterContext,
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      requestId: 'req_reasoning_only_1'
    });

    expect(result.mode).toBe('tool_flow');
    expect(result.execution?.flowId).toBe('reasoning_only_continue_flow');
    const followup = result.execution?.followup as
      | {
          metadata?: Record<string, unknown>;
          injection?: { ops?: Array<Record<string, unknown>> };
        }
      | undefined;
    expect(followup?.metadata?.clientInjectOnly).toBeUndefined();
    expect(followup?.injection?.ops).toEqual([
      { op: 'append_assistant_message', required: false },
      { op: 'append_user_text', text: '继续执行' }
    ]);
  });

  test('still uses reenter followup when tmux session is available', async () => {
    const chatResponse = buildReasoningOnlyResponse();
    const adapterContext = {
      clientTmuxSessionId: 'session-123',
      clientInjectReady: true
    } as unknown as AdapterContext;
    const result = await runServerSideToolEngine({
      chatResponse,
      adapterContext,
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      requestId: 'req_reasoning_only_2'
    });

    expect(result.mode).toBe('tool_flow');
    expect(result.execution?.flowId).toBe('reasoning_only_continue_flow');
    const followup = result.execution?.followup as
      | {
          metadata?: Record<string, unknown>;
          injection?: { ops?: Array<Record<string, unknown>> };
        }
      | undefined;
    expect(followup?.metadata?.clientInjectOnly).toBeUndefined();
    expect(followup?.injection?.ops).toEqual([
      { op: 'append_assistant_message', required: false },
      { op: 'append_user_text', text: '继续执行' }
    ]);
  });

  test('reenters pipeline instead of client injection when reasoning-only continue fires', async () => {
    const chatResponse = buildReasoningOnlyResponse();
    const adapterContext = {
      requestId: 'req_reasoning_only_3',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      clientTmuxSessionId: 'session-123',
      clientInjectReady: true,
      capturedChatRequest: {
        model: 'gpt-test',
        messages: [{ role: 'user', content: '继续完成当前任务' }]
      }
    } as unknown as AdapterContext;

    const clientInjectDispatch = jest.fn(async () => ({ ok: true } as any));
    const reenterPipeline = jest.fn(async (opts: any) => {
      expect(JSON.stringify(opts?.body?.messages ?? [])).toContain('继续执行');
      return {
        body: {
          id: 'chatcmpl_reasoning_only_followup',
          object: 'chat.completion',
          model: 'gpt-test',
          choices: [
            {
              index: 0,
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [
                  {
                    id: 'call_exec_followup',
                    type: 'function',
                    function: {
                      name: 'exec_command',
                      arguments: JSON.stringify({ cmd: 'pwd' })
                    }
                  }
                ]
              }
            }
          ]
        } as JsonObject
      };
    });

    const result = await runServerToolOrchestration({
      chat: chatResponse,
      adapterContext,
      requestId: 'req_reasoning_only_3',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      clientInjectDispatch,
      reenterPipeline
    });

    expect(result.executed).toBe(true);
    expect(result.flowId).toBe('reasoning_only_continue_flow');
    expect(reenterPipeline).toHaveBeenCalledTimes(1);
    expect(clientInjectDispatch).not.toHaveBeenCalled();
    expect((result.chat as any)?.choices?.[0]?.finish_reason).toBe('tool_calls');
  });
});
