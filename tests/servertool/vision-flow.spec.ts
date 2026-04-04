import { runServerToolOrchestration } from '../../sharedmodule/llmswitch-core/src/servertool/engine.js';
import type { AdapterContext } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/json.js';

function makeCapturedChatRequestWithImage(): JsonObject {
  return {
    model: 'gpt-test',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is in this image?' },
          { type: 'image_url', image_url: { url: 'https://example.com/test.png' } }
        ]
      }
    ],
    parameters: { temperature: 0.2 }
  } as any;
}

function makeCapturedChatRequestWithVideoUrl(partType: 'video_url' | 'image_url'): JsonObject {
  const part =
    partType === 'video_url'
      ? { type: 'video_url', video_url: { url: 'https://example.com/test.mp4' } }
      : { type: 'image_url', image_url: { url: 'https://example.com/test.mp4' } };

  return {
    model: 'gpt-test',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'describe this video' },
          part
        ]
      }
    ],
    parameters: { temperature: 0.2 }
  } as any;
}

describe('vision_auto servertool followup (entry-aware)', () => {
  test('re-enters hub with a canonical chat-like followup body (messages, non-stream)', async () => {
    const adapterContext: AdapterContext = {
      requestId: 'req-vision-1',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-chat',
      providerType: 'openai',
      hasImageAttachment: true,
      capturedChatRequest: makeCapturedChatRequestWithImage()
    } as any;

    const chatResponse: JsonObject = {
      id: 'chatcmpl-vision-1',
      object: 'chat.completion',
      model: 'gpt-test',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'ok' },
          finish_reason: 'stop'
        }
      ]
    } as any;

    let sawFollowup: any;
    const orchestration = await runServerToolOrchestration({
      chat: chatResponse,
      adapterContext,
      entryEndpoint: '/v1/responses',
      requestId: 'req-vision-1',
      providerProtocol: 'openai-chat',
      reenterPipeline: async (opts: any) => {
        if (String(opts.requestId).includes(':vision_followup')) {
          sawFollowup = opts;
          return {
            body: {
              id: 'chatcmpl-vision-followup-1',
              object: 'chat.completion',
              model: 'gpt-test',
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: 'ok' },
                  finish_reason: 'stop'
                }
              ]
            } as JsonObject
          };
        }
        // backend :vision analysis hop
        return {
          body: {
            id: 'chatcmpl-vision-analysis',
            object: 'chat.completion',
            model: 'gpt-test',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'vision summary' },
                finish_reason: 'stop'
              }
            ]
          } as JsonObject
        };
      }
    });

    expect(orchestration.executed).toBe(true);
    expect(orchestration.flowId).toBe('vision_flow');
    const followupMeta = sawFollowup?.metadata as any;
    const followupFlag =
      followupMeta?.serverToolFollowup ?? followupMeta?.__rt?.serverToolFollowup;
    expect(followupFlag).toBe(true);
    expect(sawFollowup?.metadata?.stream).toBe(false);

    const body = sawFollowup?.body as any;
    expect(body).toBeDefined();
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.stream).toBe(false);
    expect(body.parameters?.stream).toBeUndefined();
    expect(JSON.stringify(body.messages)).toContain('[Vision] vision summary');
  });

  test('does not run vision flow when latest user message uses video_url', async () => {
    const adapterContext: AdapterContext = {
      requestId: 'req-vision-video-1',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-chat',
      providerType: 'openai',
      hasImageAttachment: true,
      capturedChatRequest: makeCapturedChatRequestWithVideoUrl('video_url')
    } as any;

    const chatResponse: JsonObject = {
      id: 'chatcmpl-vision-video-1',
      object: 'chat.completion',
      model: 'gpt-test',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'ok' },
          finish_reason: 'stop'
        }
      ]
    } as any;

    let reenterCalled = 0;
    const reenterPipeline = async () => {
      reenterCalled += 1;
      return { body: {} as JsonObject };
    };
    const orchestration = await runServerToolOrchestration({
      chat: chatResponse,
      adapterContext,
      entryEndpoint: '/v1/responses',
      requestId: 'req-vision-video-1',
      providerProtocol: 'openai-chat',
      reenterPipeline
    });

    expect(orchestration.executed).toBe(false);
    expect(reenterCalled).toBe(0);
  });

  test('does not run vision flow when latest user image_url is an mp4 url', async () => {
    const adapterContext: AdapterContext = {
      requestId: 'req-vision-video-2',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-chat',
      providerType: 'openai',
      hasImageAttachment: true,
      capturedChatRequest: makeCapturedChatRequestWithVideoUrl('image_url')
    } as any;

    const chatResponse: JsonObject = {
      id: 'chatcmpl-vision-video-2',
      object: 'chat.completion',
      model: 'gpt-test',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'ok' },
          finish_reason: 'stop'
        }
      ]
    } as any;

    let reenterCalled = 0;
    const reenterPipeline = async () => {
      reenterCalled += 1;
      return { body: {} as JsonObject };
    };
    const orchestration = await runServerToolOrchestration({
      chat: chatResponse,
      adapterContext,
      entryEndpoint: '/v1/responses',
      requestId: 'req-vision-video-2',
      providerProtocol: 'openai-chat',
      reenterPipeline
    });

    expect(orchestration.executed).toBe(false);
    expect(reenterCalled).toBe(0);
  });

  test('does not run vision flow when route already resolved to vision capability', async () => {
    const adapterContext: AdapterContext = {
      requestId: 'req-vision-route-bypass',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-chat',
      providerType: 'openai',
      routeId: 'vision',
      hasImageAttachment: true,
      capturedChatRequest: makeCapturedChatRequestWithImage()
    } as any;

    const chatResponse: JsonObject = {
      id: 'chatcmpl-vision-route-bypass',
      object: 'chat.completion',
      model: 'gpt-test',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'ok' },
          finish_reason: 'stop'
        }
      ]
    } as any;

    let reenterCalled = 0;
    const orchestration = await runServerToolOrchestration({
      chat: chatResponse,
      adapterContext,
      entryEndpoint: '/v1/responses',
      requestId: 'req-vision-route-bypass',
      providerProtocol: 'openai-chat',
      reenterPipeline: async () => {
        reenterCalled += 1;
        return { body: {} as JsonObject };
      }
    });

    expect(orchestration.executed).toBe(false);
    expect(reenterCalled).toBe(0);
  });

  test('does not run vision flow when runtime metadata marks qwen image generation', async () => {
    const adapterContext: AdapterContext = {
      requestId: 'req-vision-imagegen-rt',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      providerType: 'openai',
      hasImageAttachment: true,
      __rt: {
        qwenImageGeneration: {
          enabled: true,
          mode: 'edit'
        }
      },
      capturedChatRequest: makeCapturedChatRequestWithImage()
    } as any;

    const chatResponse: JsonObject = {
      id: 'chatcmpl-vision-imagegen-rt',
      object: 'chat.completion',
      model: 'qwenchat.qwen3.6-plus',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'ok' },
          finish_reason: 'stop'
        }
      ]
    } as any;

    let reenterCalled = 0;
    const orchestration = await runServerToolOrchestration({
      chat: chatResponse,
      adapterContext,
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-vision-imagegen-rt',
      providerProtocol: 'openai-chat',
      reenterPipeline: async () => {
        reenterCalled += 1;
        return { body: {} as JsonObject };
      }
    });

    expect(orchestration.executed).toBe(false);
    expect(reenterCalled).toBe(0);
  });

  test('does not run vision flow when captured request metadata marks qwen image generation', async () => {
    const captured = makeCapturedChatRequestWithImage();
    (captured as any).metadata = {
      qwenImageGeneration: {
        enabled: true,
        mode: 'generate'
      }
    };

    const adapterContext: AdapterContext = {
      requestId: 'req-vision-imagegen-captured',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      providerType: 'openai',
      hasImageAttachment: true,
      capturedChatRequest: captured
    } as any;

    const chatResponse: JsonObject = {
      id: 'chatcmpl-vision-imagegen-captured',
      object: 'chat.completion',
      model: 'qwenchat.qwen3.6-plus',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'ok' },
          finish_reason: 'stop'
        }
      ]
    } as any;

    let reenterCalled = 0;
    const orchestration = await runServerToolOrchestration({
      chat: chatResponse,
      adapterContext,
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-vision-imagegen-captured',
      providerProtocol: 'openai-chat',
      reenterPipeline: async () => {
        reenterCalled += 1;
        return { body: {} as JsonObject };
      }
    });

    expect(orchestration.executed).toBe(false);
    expect(reenterCalled).toBe(0);
  });
});
