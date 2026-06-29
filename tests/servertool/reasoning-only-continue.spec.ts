import { jest } from '@jest/globals';
import { runServerSideToolEngine } from '../../sharedmodule/llmswitch-core/src/servertool/server-side-tools-impl.js';
import { runServerToolOrchestration } from '../../sharedmodule/llmswitch-core/src/servertool/engine.js';
import type { AdapterContext } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/json.js';
import { MetadataCenter } from '../../src/server/runtime/http-server/metadata-center/metadata-center.js';

function bindMetadataCenter<T extends Record<string, unknown>>(
  adapterContext: T,
  providerProtocol = 'openai-chat'
): T {
  const center = MetadataCenter.attach(adapterContext);
  center.writeRuntimeControl(
    'providerProtocol',
    providerProtocol,
    {
      module: 'tests/servertool/reasoning-only-continue.spec.ts',
      symbol: 'bindMetadataCenter',
      stage: 'test'
    }
  );
  const requestId = typeof adapterContext.requestId === 'string' ? adapterContext.requestId : undefined;
  if (requestId) {
    center.writeRequestTruth(
      'requestId',
      requestId,
      {
        module: 'tests/servertool/reasoning-only-continue.spec.ts',
        symbol: 'bindMetadataCenter',
        stage: 'test'
      }
    );
  }
  return adapterContext;
}

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

describe('servertool reasoning-only empty assistant contract', () => {
  test('does not trigger auto continue when assistant payload is empty', async () => {
    const chatResponse = buildReasoningOnlyResponse();
    const adapterContext = bindMetadataCenter({ requestId: 'req_reasoning_only_1' } as AdapterContext);
    const result = await runServerSideToolEngine({
      chatResponse,
      adapterContext,
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      requestId: 'req_reasoning_only_1'
    });

    expect(result.mode).toBe('passthrough');
    expect(result.execution).toBeUndefined();
  });

  test('still does not trigger when tmux session is available', async () => {
    const chatResponse = buildReasoningOnlyResponse();
    const adapterContext = bindMetadataCenter({
      requestId: 'req_reasoning_only_2',
      clientTmuxSessionId: 'session-123',
      clientInjectReady: true
    } as unknown as AdapterContext);
    const result = await runServerSideToolEngine({
      chatResponse,
      adapterContext,
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      requestId: 'req_reasoning_only_2'
    });

    expect(result.mode).toBe('passthrough');
    expect(result.execution).toBeUndefined();
  });

  test('orchestration also skips empty reasoning-only payloads', async () => {
    const chatResponse = buildReasoningOnlyResponse();
    const adapterContext = bindMetadataCenter({
      requestId: 'req_reasoning_only_3',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      clientTmuxSessionId: 'session-123',
      clientInjectReady: true,
      capturedChatRequest: {
        model: 'gpt-test',
        messages: [{ role: 'user', content: '继续完成当前任务' }]
      }
    } as unknown as AdapterContext, 'openai-responses');

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

    expect(result.executed).toBe(false);
    expect(result.flowId).toBeUndefined();
    expect(reenterPipeline).toHaveBeenCalledTimes(0);
    expect(clientInjectDispatch).not.toHaveBeenCalled();
    expect((result.chat as any)?.choices?.[0]?.finish_reason).toBe('stop');
  });
});
