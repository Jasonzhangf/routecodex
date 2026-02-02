import { runServerToolOrchestration } from '../../sharedmodule/llmswitch-core/src/servertool/engine.js';
import type { AdapterContext } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/json.js';

describe('antigravity_thought_signature_bootstrap servertool', () => {
  test('on 429 error: performs preflight clock.get then replays original request', async () => {
    const capturedChatRequest: JsonObject = {
      model: 'gemini-test',
      messages: [
        { role: 'user', content: 'FIRST USER MESSAGE (stable session seed)' },
        { role: 'user', content: 'second user msg' }
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'shell',
            description: 'noop',
            parameters: { type: 'object', properties: {}, required: [], additionalProperties: false }
          }
        }
      ],
      parameters: { temperature: 0.2 }
    };

    const errorChat: JsonObject = {
      id: 'chatcmpl_err_1',
      object: 'chat.completion',
      model: 'gemini-test',
      // Non-empty content to avoid auto-flow `gemini_empty_reply_continue` stealing the match.
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'RATE_LIMITED' } }],
      error: { code: 429, status: 429, message: 'HTTP 429: RESOURCE_EXHAUSTED' }
    };

    const adapterContext: AdapterContext = {
      requestId: 'req-bootstrap-1',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'gemini-chat',
      providerKey: 'antigravity.test',
      capturedChatRequest
    } as any;

    const calls: any[] = [];
    const orchestration = await runServerToolOrchestration({
      chat: errorChat,
      adapterContext,
      requestId: 'req-bootstrap-1',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'gemini-chat',
      reenterPipeline: async (opts: any) => {
        calls.push(opts);
        if (String(opts?.requestId || '').includes(':antigravity_ts_bootstrap')) {
          // Preflight result (chat-like) – success
          return {
            body: {
              id: 'chatcmpl_preflight_ok',
              object: 'chat.completion',
              model: 'gemini-test',
              choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'OK' } }]
            } as JsonObject
          };
        }
        if (String(opts?.requestId || '').includes(':antigravity_ts_replay')) {
          return {
            body: {
              id: 'chatcmpl_replay_ok',
              object: 'chat.completion',
              model: 'gemini-test',
              choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'done' } }]
            } as JsonObject
          };
        }
        throw new Error(`unexpected reenter requestId: ${String(opts?.requestId)}`);
      }
    });

    expect(orchestration.executed).toBe(true);
    expect(orchestration.flowId).toBe('antigravity_thought_signature_bootstrap');
    expect(calls.length).toBe(2);

    const preflight = calls[0];
    expect(String(preflight?.requestId || '')).toContain(':antigravity_ts_bootstrap');
    expect(preflight?.metadata?.stream).toBe(false);
    expect(preflight?.metadata?.__shadowCompareForcedProviderKey).toBe('antigravity.test');
    expect(preflight?.metadata?.__hubEntry).toBe('chat_process');
    expect(preflight?.metadata?.routeHint).toBe('');
    expect(preflight?.metadata?.__rt?.serverToolFollowup).toBe(true);
    expect(preflight?.metadata?.__rt?.antigravityThoughtSignatureBootstrap).toBe(true);

    const preflightBody = preflight?.body as any;
    expect(preflightBody?.stream).toBe(false);
    expect(Array.isArray(preflightBody?.messages)).toBe(true);
    // Must keep the first user message identical to preserve derived session_id.
    expect(preflightBody.messages[0]).toEqual(capturedChatRequest.messages?.[0]);
    const preflightText = JSON.stringify(preflightBody.messages);
    expect(preflightText).toContain('clock');
    expect(preflightText).toContain('OK');
    expect(Array.isArray(preflightBody.tools)).toBe(true);
    const toolNames = preflightBody.tools.map((t: any) => t?.function?.name);
    expect(toolNames).toContain('clock');
    expect(preflightBody.parameters?.tool_config?.functionCallingConfig?.allowedFunctionNames).toEqual(['clock']);

    const replay = calls[1];
    expect(String(replay?.requestId || '')).toContain(':antigravity_ts_replay');
    expect(replay?.metadata?.stream).toBe(false);
    expect(replay?.metadata?.__hubEntry).toBe('chat_process');
    expect(replay?.metadata?.routeHint).toBe('');
    expect(replay?.metadata?.__rt?.serverToolFollowup).toBe(true);
    expect(replay?.metadata?.__shadowCompareForcedProviderKey).toBe('antigravity.test');

    const replayBody = replay?.body as any;
    expect(replayBody?.messages?.length).toBe(2);
    expect(replayBody.messages[0]).toEqual(capturedChatRequest.messages?.[0]);
    expect(replayBody.messages[1]).toEqual(capturedChatRequest.messages?.[1]);
    expect(Array.isArray(replayBody.tools)).toBe(true);
    expect(replayBody.tools.map((t: any) => t?.function?.name)).toContain('shell');
  });

  test('does not replay when preflight still returns 429', async () => {
    const capturedChatRequest: JsonObject = {
      model: 'gemini-test',
      messages: [{ role: 'user', content: 'FIRST USER MESSAGE' }]
    };

    const errorChat: JsonObject = {
      id: 'chatcmpl_err_2',
      object: 'chat.completion',
      model: 'gemini-test',
      // Non-empty content to avoid auto-flow `gemini_empty_reply_continue` stealing the match.
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'RATE_LIMITED' } }],
      error: { code: 429, status: 429, message: 'HTTP 429' }
    };

    const adapterContext: AdapterContext = {
      requestId: 'req-bootstrap-2',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'gemini-chat',
      providerKey: 'antigravity.test',
      capturedChatRequest
    } as any;

    const calls: any[] = [];
    const orchestration = await runServerToolOrchestration({
      chat: errorChat,
      adapterContext,
      requestId: 'req-bootstrap-2',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'gemini-chat',
      reenterPipeline: async (opts: any) => {
        calls.push(opts);
        return {
          body: {
            id: 'chatcmpl_preflight_err',
            object: 'chat.completion',
            model: 'gemini-test',
            choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '' } }],
            error: { code: 429, status: 429, message: 'HTTP 429' }
          } as JsonObject
        };
      }
    });

    expect(orchestration.executed).toBe(true);
    expect(orchestration.flowId).toBe('antigravity_thought_signature_bootstrap');
    expect(calls.length).toBe(1);
  });
});
