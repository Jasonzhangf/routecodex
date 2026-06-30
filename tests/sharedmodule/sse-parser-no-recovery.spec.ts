import { describe, expect, it } from '@jest/globals';
import { Readable } from 'node:stream';

import { ResponsesSseToJsonConverter } from '../../sharedmodule/llmswitch-core/src/sse/sse-to-json/responses-sse-to-json-converter.js';
import { AnthropicSseToJsonConverter } from '../../sharedmodule/llmswitch-core/src/sse/sse-to-json/anthropic-sse-to-json-converter.js';
import { GeminiSseToJsonConverter } from '../../sharedmodule/llmswitch-core/src/sse/sse-to-json/gemini-sse-to-json-converter.js';

describe('SSE parser no-recovery boundary', () => {
  it('fails malformed Responses SSE frames instead of recovering past them', async () => {
    const converter = new ResponsesSseToJsonConverter();

    await expect(converter.convertSseToJson(Readable.from([
      'event: response.created\n',
      'data: not-json\n\n',
      'event: response.done\n',
      'data: {"type":"response.done","response":{"id":"resp_should_not_recover","object":"response","created_at":1,"status":"completed","model":"gpt-test","output":[]}}\n\n'
    ]), {
      requestId: 'req_responses_parser_no_recovery',
      model: 'gpt-test'
    })).rejects.toMatchObject({
      code: 'SSE_TO_JSON_ERROR',
      requestExecutorProviderErrorStage: 'provider.sse_decode'
    });
  });

  it('fails malformed Anthropic SSE frames instead of recovering past them', async () => {
    const converter = new AnthropicSseToJsonConverter();

    await expect(converter.convertSseToJson(Readable.from([
      'event: message_start\n',
      'data: not-json\n\n',
      'event: message_stop\n',
      'data: {"type":"message_stop"}\n\n'
    ]), {
      requestId: 'req_anthropic_parser_no_recovery',
      model: 'claude-sonnet-4-5'
    })).rejects.toMatchObject({
      code: 'ANTHROPIC_SSE_TO_JSON_FAILED',
      requestExecutorProviderErrorStage: 'provider.sse_decode'
    });
  });

  it('fails malformed Gemini SSE frames instead of recovering past them', async () => {
    const converter = new GeminiSseToJsonConverter();

    await expect(converter.convertSseToJson(Readable.from([
      'event: gemini.data\n',
      'data: not-json\n\n',
      'event: gemini.done\n',
      'data: {"candidates":[]}\n\n'
    ]), {
      requestId: 'req_gemini_parser_no_recovery',
      model: 'gemini-test'
    })).rejects.toMatchObject({
      code: 'GEMINI_SSE_TO_JSON_FAILED'
    });
  });

  it('fails Gemini data frames with missing part instead of silently dropping them', async () => {
    const converter = new GeminiSseToJsonConverter();

    await expect(converter.convertSseToJson(Readable.from([
      'event: gemini.data\n',
      'data: {"type":"gemini.data","protocol":"gemini-chat","direction":"output","candidateIndex":0,"partIndex":0,"role":"model"}\n\n',
      'event: gemini.done\n',
      'data: {"type":"gemini.done","protocol":"gemini-chat","direction":"output","data":{"kind":"done","candidates":[{"index":0,"finishReason":"STOP"}]}}\n\n'
    ]), {
      requestId: 'req_gemini_missing_part_no_swallow',
      model: 'gemini-test'
    })).rejects.toThrow('Invalid Gemini data event: missing part');
  });

  it('fails Gemini data frames with scalar part instead of materializing malformed content', async () => {
    const converter = new GeminiSseToJsonConverter();

    await expect(converter.convertSseToJson(Readable.from([
      'event: gemini.data\n',
      'data: {"type":"gemini.data","protocol":"gemini-chat","direction":"output","candidateIndex":0,"partIndex":0,"role":"model","part":"hello"}\n\n',
      'event: gemini.done\n',
      'data: {"type":"gemini.done","protocol":"gemini-chat","direction":"output","data":{"kind":"done","candidates":[{"index":0,"finishReason":"STOP"}]}}\n\n'
    ]), {
      requestId: 'req_gemini_scalar_part_no_swallow',
      model: 'gemini-test'
    })).rejects.toThrow('Invalid Gemini data event: invalid part at index 0');
  });

  it('fails Gemini done frames with invalid candidate metadata instead of silently skipping it', async () => {
    const converter = new GeminiSseToJsonConverter();

    await expect(converter.convertSseToJson(Readable.from([
      'event: gemini.data\n',
      'data: {"type":"gemini.data","protocol":"gemini-chat","direction":"output","candidateIndex":0,"partIndex":0,"role":"model","part":{"text":"hello"}}\n\n',
      'event: gemini.done\n',
      'data: {"type":"gemini.done","protocol":"gemini-chat","direction":"output","candidates":[null]}\n\n'
    ]), {
      requestId: 'req_gemini_invalid_done_candidate_no_swallow',
      model: 'gemini-test'
    })).rejects.toThrow('Invalid Gemini done event: invalid candidate at index 0');
  });

  it('fails Gemini data frames with missing candidateIndex instead of defaulting to candidate zero', async () => {
    const converter = new GeminiSseToJsonConverter();

    await expect(converter.convertSseToJson(Readable.from([
      'event: gemini.data\n',
      'data: {"type":"gemini.data","protocol":"gemini-chat","direction":"output","partIndex":0,"role":"model","part":{"text":"hello"}}\n\n',
      'event: gemini.done\n',
      'data: {"type":"gemini.done","protocol":"gemini-chat","direction":"output","candidates":[{"index":0,"finishReason":"STOP"}]}\n\n'
    ]), {
      requestId: 'req_gemini_missing_candidate_index_no_default',
      model: 'gemini-test'
    })).rejects.toThrow('Invalid Gemini data event: missing candidateIndex');
  });

  it('fails Gemini data frames with missing role instead of defaulting to model', async () => {
    const converter = new GeminiSseToJsonConverter();

    await expect(converter.convertSseToJson(Readable.from([
      'event: gemini.data\n',
      'data: {"type":"gemini.data","protocol":"gemini-chat","direction":"output","candidateIndex":0,"partIndex":0,"part":{"text":"hello"}}\n\n',
      'event: gemini.done\n',
      'data: {"type":"gemini.done","protocol":"gemini-chat","direction":"output","candidates":[{"index":0,"finishReason":"STOP"}]}\n\n'
    ]), {
      requestId: 'req_gemini_missing_role_no_default',
      model: 'gemini-test'
    })).rejects.toThrow('Invalid Gemini data event: missing role');
  });

  it('fails Gemini done frames with missing candidates instead of materializing partial metadata', async () => {
    const converter = new GeminiSseToJsonConverter();

    await expect(converter.convertSseToJson(Readable.from([
      'event: gemini.data\n',
      'data: {"type":"gemini.data","protocol":"gemini-chat","direction":"output","candidateIndex":0,"partIndex":0,"role":"model","part":{"text":"hello"}}\n\n',
      'event: gemini.done\n',
      'data: {"type":"gemini.done","protocol":"gemini-chat","direction":"output","usageMetadata":{"totalTokenCount":1}}\n\n'
    ]), {
      requestId: 'req_gemini_missing_done_candidates_no_partial_metadata',
      model: 'gemini-test'
    })).rejects.toThrow('Invalid Gemini done event: missing candidates');
  });
});
