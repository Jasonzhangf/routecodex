import { describe, expect, it } from '@jest/globals';

import { __requestExecutorTestables } from '../../../../src/server/runtime/http-server/request-executor';

describe('request-executor qwenchat non-stream decode tag', () => {
  it('falls back to post-convert metadata delivery marker when pre-convert body hint is absent', () => {
    const tag = __requestExecutorTestables.resolveQwenChatProviderDecodeTag({
      pipelineMetadata: {
        __rt: {
          qwenchatNonstreamDelivery: 'json'
        }
      },
      providerResponseBody: {
        id: 'chatcmpl_test'
      }
    });

    expect(tag).toBe('qwen.nonstream=json');
  });

  it('includes probe metrics together with non-stream delivery marker', () => {
    const tag = __requestExecutorTestables.resolveQwenChatProviderDecodeTag({
      pipelineMetadata: {
        __rt: {
          qwenchatNonstreamDelivery: 'sse_fallback',
          qwenchatSseProbe: {
            firstUpstreamChunkMs: 123,
            upstreamChunkCount: 4
          }
        }
      }
    });

    expect(tag).toBe('qwen.nonstream=sse_fallback qwen.first_chunk=123ms qwen.chunks=4');
  });

  it('emits an explicit missing marker for qwenchat non-stream requests when live delivery evidence is absent', () => {
    const tag = __requestExecutorTestables.resolveQwenChatProviderDecodeTag({
      pipelineMetadata: {},
      providerResponseBody: {
        id: 'chatcmpl_missing_marker'
      },
      expectNonstreamDelivery: true,
      compatibilityProfile: 'chat:qwenchat-web',
      providerClassName: 'QwenChatHttpProvider',
      providerRequestedStream: true
    });

    expect(tag).toBe('qwen.nonstream=missing qwen.compat=chat:qwenchat-web qwen.class=QwenChatHttpProvider qwen.req_stream=true');
  });
});
