import { describe, expect, it } from '@jest/globals';
import { Readable } from 'node:stream';

import { ProviderProtocolError } from '../../../../../../provider-protocol-error.js';
import { runRespInboundStage1SseDecode } from '../index.js';

function createAdapterContext(overrides: Record<string, unknown> = {}) {
  return {
    requestId: 'req-resp-inbound-stage1',
    entryEndpoint: '/v1/responses',
    providerProtocol: 'anthropic-messages',
    ...overrides
  } as any;
}

function createStageRecorder(target: Array<Record<string, unknown>>) {
  return {
    record(_stage: string, payload: object) {
      target.push(payload as Record<string, unknown>);
    }
  };
}

describe('resp-inbound-stage1-sse-decode native wrapper', () => {
  it('surfaces protocol_unsupported through native descriptor', async () => {
    const stageRecords: Array<Record<string, unknown>> = [];

    await expect(
      runRespInboundStage1SseDecode({
        providerProtocol: 'unsupported-protocol' as any,
        payload: {
          __sse_responses: Readable.from(['event: message\n', 'data: noop\n\n'])
        } as any,
        adapterContext: createAdapterContext({
          requestId: 'req-resp-inbound-stage1-unsupported',
          providerProtocol: 'unsupported-protocol'
        }),
        wantsStream: true,
        stageRecorder: createStageRecorder(stageRecords)
      } as any)
    ).rejects.toMatchObject({
      code: 'SSE_DECODE_ERROR',
      details: expect.objectContaining({
        reason: 'protocol_unsupported',
        requestId: 'req-resp-inbound-stage1-unsupported'
      })
    });

    expect(stageRecords.at(-1)).toMatchObject({
      reason: 'protocol_unsupported'
    });
  });

  it('surfaces sse_wrapper_error through native descriptor', async () => {
    const stageRecords: Array<Record<string, unknown>> = [];
    await expect(
      runRespInboundStage1SseDecode({
        providerProtocol: 'openai-chat',
        payload: {
          mode: 'sse',
          error: 'upstream closed stream',
          __sse_responses: Readable.from(['data: ignored\n\n'])
        } as any,
        adapterContext: createAdapterContext({ providerProtocol: 'openai-chat' }),
        wantsStream: true,
        stageRecorder: createStageRecorder(stageRecords)
      })
    ).rejects.toMatchObject({
      code: 'SSE_DECODE_ERROR',
      details: expect.objectContaining({
        requestId: 'req-resp-inbound-stage1',
        message: 'upstream closed stream'
      })
    });
    expect(stageRecords.at(-1)).toMatchObject({
      reason: 'sse_wrapper_error',
      error: 'upstream closed stream'
    });
  });

  it('classifies anthropic retryable decode failure via native descriptor', async () => {
    const decoderError = Object.assign(new Error('internal network failure while streaming'), {
      code: 'anthropic_sse_to_json_failed'
    });
    const payload = {
      __sse_responses: Readable.from(['event: message\n', 'data: noop\n\n'])
    } as any;
    const stageRecords: Array<Record<string, unknown>> = [];

    const registry = await import('../../../../../../../sse/index.js');
    const codec = registry.defaultSseCodecRegistry.get('anthropic-messages');
    const original = codec.convertSseToJson.bind(codec);
    codec.convertSseToJson = async () => {
      throw decoderError;
    };

    try {
      await expect(
        runRespInboundStage1SseDecode({
          providerProtocol: 'anthropic-messages',
          payload,
          adapterContext: createAdapterContext({ estimatedInputTokens: 1234, maxContextTokens: 4096 }),
          wantsStream: true,
          stageRecorder: createStageRecorder(stageRecords)
        })
      ).rejects.toMatchObject({
        code: 'HTTP_502',
        status: 502,
        details: expect.objectContaining({
          retryable: true,
          statusCode: 502,
          upstreamCode: 'anthropic_sse_to_json_failed'
        })
      });
    } finally {
      codec.convertSseToJson = original;
    }

    expect(stageRecords.at(-1)).toMatchObject({
      error: 'internal network failure while streaming',
      upstreamCode: 'anthropic_sse_to_json_failed',
      statusCode: 502,
      estimatedPromptTokens: 1234,
      maxContextTokens: 4096
    });
  });

  it('classifies context_length_exceeded through native finalize path', async () => {
    const decoderError = Object.assign(new Error('达到对话长度上限'), {
      code: 'provider_decode_failed',
      context: {
        errorData: {
          finish_reason: 'context_length_exceeded'
        }
      }
    });
    const payload = {
      __sse_responses: Readable.from(['event: message\n', 'data: noop\n\n'])
    } as any;
    const stageRecords: Array<Record<string, unknown>> = [];

    const registry = await import('../../../../../../../sse/index.js');
    const codec = registry.defaultSseCodecRegistry.get('anthropic-messages');
    const original = codec.convertSseToJson.bind(codec);
    codec.convertSseToJson = async () => {
      throw decoderError;
    };

    let capturedError: unknown;

    try {
      capturedError = await runRespInboundStage1SseDecode({
        providerProtocol: 'anthropic-messages',
        payload,
        adapterContext: createAdapterContext({ estimatedInputTokens: 8192, maxContextTokens: 4096 }),
        wantsStream: true,
        stageRecorder: createStageRecorder(stageRecords)
      }).catch((error) => error);
      expect(capturedError).toMatchObject({
        code: 'SSE_DECODE_ERROR',
        details: expect.objectContaining({
          reason: 'context_length_exceeded',
          estimatedPromptTokens: 8192,
          maxContextTokens: 4096
        })
      });
    } finally {
      codec.convertSseToJson = original;
    }

    expect(capturedError).toBeInstanceOf(ProviderProtocolError);
    expect((capturedError as Error).message).toContain('context too long; please compress conversation context and retry');

    expect(stageRecords.at(-1)).toMatchObject({
      reason: 'context_length_exceeded',
      error: '达到对话长度上限',
      estimatedPromptTokens: 8192,
      maxContextTokens: 4096
    });
  });

  it('decodes snapshot-shaped raw SSE payloads', async () => {
    const anthropicRaw = [
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"msg_test_1","type":"message","role":"assistant","model":"mimo-v2.5-pro","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"OK"}}',
      '',
      'event: content_block_stop',
      'data: {"type":"content_block_stop","index":0}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      ''
    ].join('\n');
    const result = await runRespInboundStage1SseDecode({
      providerProtocol: 'anthropic-messages',
      payload: {
        mode: 'sse',
        raw: anthropicRaw
      } as any,
      adapterContext: createAdapterContext({
        requestId: 'req-resp-inbound-stage1-raw-sse',
        providerProtocol: 'anthropic-messages'
      }),
      wantsStream: false
    });

    expect(result.decodedFromSse).toBe(true);
    expect(result.payload).toMatchObject({
      id: 'msg_test_1',
      stop_reason: 'end_turn',
      content: [
        {
          type: 'text',
          text: 'OK'
        }
      ]
    });
  });
});
