import { runServerToolOrchestration } from '../../sharedmodule/llmswitch-core/src/servertool/engine.js';
import type { AdapterContext } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/json.js';
import { buildResponsesRequestFromChat } from '../../sharedmodule/llmswitch-core/src/conversion/responses/responses-openai-bridge.js';

describe('gemini_empty_reply_continue servertool', () => {
  test('builds /v1/responses followup without trimming history (empty reply)', async () => {
    const capturedChatRequest: JsonObject = {
      model: 'gemini-test',
      messages: Array.from({ length: 20 }, (_, i) => ({ role: 'user', content: `m${i}` })),
      parameters: {
        max_output_tokens: 321,
        temperature: 0.2,
        // Followup must be non-streaming regardless of the original request.
        stream: true
      }
    };

    const responsesPayloadEmpty: JsonObject = {
      id: 'resp-empty-1',
      object: 'response',
      model: 'gemini-test',
      status: 'completed',
      output: []
    };

    const adapterContext: AdapterContext = {
      requestId: 'req-gemini-empty-1',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'gemini-chat',
      providerKey: 'antigravity.test',
      capturedChatRequest
    } as any;

    let sawFollowupPayload: any;
    const orchestration = await runServerToolOrchestration({
      chat: responsesPayloadEmpty,
      adapterContext,
      requestId: 'req-gemini-empty-1',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'gemini-chat',
      reenterPipeline: async (opts: any) => {
        sawFollowupPayload = opts;
        return {
          body: {
            id: 'resp-followup-1',
            object: 'response',
            model: 'gemini-test',
            status: 'completed',
            output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }]
          } as JsonObject
        };
      }
    });

    expect(orchestration.executed).toBe(true);
    expect(orchestration.flowId).toBe('gemini_empty_reply_continue');
    expect(sawFollowupPayload?.metadata?.serverToolFollowup).toBe(true);
    expect(sawFollowupPayload?.metadata?.stream).toBe(false);
    expect(sawFollowupPayload?.metadata?.preserveRouteHint).toBe(false);
    expect(sawFollowupPayload?.metadata?.disableStickyRoutes).toBe(true);
    expect(sawFollowupPayload?.metadata?.serverToolOriginalEntryEndpoint).toBe('/v1/responses');

    const body = sawFollowupPayload?.body as any;
    expect(body).toBeDefined();
    expect(body.messages).toBeUndefined();
    expect(Array.isArray(body.input)).toBe(true);
    expect(body.stream).toBe(false);
    expect(body.parameters).toBeDefined();
    expect(body.parameters.max_output_tokens).toBe(321);
    expect(body.parameters.temperature).toBe(0.2);
    expect(body.parameters.stream).toBeUndefined();

    const inputText = JSON.stringify(body.input);
    for (let i = 0; i < 20; i += 1) {
      expect(inputText).toContain(`m${i}`);
    }
    expect(inputText).toContain('继续执行');
  });

  test('builds /v1/responses followup when captured request is a Responses payload', async () => {
    const capturedChatSeed: JsonObject = {
      model: 'gemini-test',
      messages: Array.from({ length: 12 }, (_, i) => ({ role: 'user', content: `m${i}` })),
      parameters: {
        max_output_tokens: 222,
        temperature: 0.3,
        stream: true
      }
    };

    const capturedChatRequest = buildResponsesRequestFromChat(capturedChatSeed as any, {
      stream: true
    }).request as unknown as JsonObject;

    const responsesPayloadEmpty: JsonObject = {
      id: 'resp-empty-2',
      object: 'response',
      model: 'gemini-test',
      status: 'completed',
      output: []
    };

    const adapterContext: AdapterContext = {
      requestId: 'req-gemini-empty-2',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'gemini-chat',
      providerKey: 'antigravity.test',
      capturedChatRequest
    } as any;

    let sawFollowupBody: any;
    await runServerToolOrchestration({
      chat: responsesPayloadEmpty,
      adapterContext,
      requestId: 'req-gemini-empty-2',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'gemini-chat',
      reenterPipeline: async (opts: any) => {
        sawFollowupBody = opts?.body;
        return {
          body: {
            id: 'resp-followup-2',
            object: 'response',
            model: 'gemini-test',
            status: 'completed',
            output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }]
          } as JsonObject
        };
      }
    });

    expect(sawFollowupBody).toBeDefined();
    expect(sawFollowupBody.messages).toBeUndefined();
    expect(Array.isArray(sawFollowupBody.input)).toBe(true);
    expect(sawFollowupBody.stream).toBe(false);
    expect(sawFollowupBody.parameters?.max_output_tokens).toBe(222);
    expect(sawFollowupBody.parameters?.temperature).toBe(0.3);
    expect(sawFollowupBody.parameters?.stream).toBeUndefined();
    const inputText = JSON.stringify(sawFollowupBody.input);
    for (let i = 0; i < 12; i += 1) {
      expect(inputText).toContain(`m${i}`);
    }
    expect(inputText).toContain('继续执行');
  });

  test('includes truncated assistant content before continue (finish_reason=length)', async () => {
    const capturedChatRequest: JsonObject = {
      model: 'gemini-test',
      messages: [{ role: 'user', content: 'hi' }],
      parameters: {
        max_output_tokens: 123,
        stream: true
      }
    };

    const chatPayloadLength: JsonObject = {
      id: 'chatcmpl-gemini-length-1',
      object: 'chat.completion',
      model: 'gemini-test',
      choices: [
        { index: 0, message: { role: 'assistant', content: 'partial' }, finish_reason: 'length' }
      ]
    };

    const adapterContext: AdapterContext = {
      requestId: 'req-gemini-length-1',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'gemini-chat',
      providerKey: 'antigravity.test',
      capturedChatRequest
    } as any;

    let sawFollowupBody: any;
    await runServerToolOrchestration({
      chat: chatPayloadLength,
      adapterContext,
      requestId: 'req-gemini-length-1',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'gemini-chat',
      reenterPipeline: async (opts: any) => {
        sawFollowupBody = opts?.body;
        return {
          body: {
            id: 'resp-followup-2',
            object: 'response',
            model: 'gemini-test',
            status: 'completed',
            output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }]
          } as JsonObject
        };
      }
    });

    const inputText = JSON.stringify(sawFollowupBody?.input ?? []);
    expect(inputText).toContain('hi');
    expect(inputText).toContain('partial');
    expect(inputText).toContain('继续执行');
    expect(sawFollowupBody?.stream).toBe(false);
    expect(sawFollowupBody?.parameters?.max_output_tokens).toBe(123);
    expect(sawFollowupBody?.parameters?.stream).toBeUndefined();
  });
});
