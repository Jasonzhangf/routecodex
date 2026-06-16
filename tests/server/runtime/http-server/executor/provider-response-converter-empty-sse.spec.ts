import { describe, expect, it } from '@jest/globals';

import { remapBridgeSseErrorToHttp } from '../../../../../src/server/runtime/http-server/executor/provider-response-sse-error-normalizer.js';

describe('provider-response-converter empty SSE failures', () => {
  it('remaps empty OpenAI chat SSE bridge failures to retryable SSE decode errors', () => {
    const error: Record<string, unknown> = { code: 'HTTP_HANDLER_ERROR' };
    const changed = remapBridgeSseErrorToHttp(
      error,
      'Rust HubPipeline response path failed: hub_pipeline_error: OpenAI chat SSE response did not contain JSON data events'
    );

    expect(changed).toBe(true);
    expect(error).toMatchObject({
      code: 'SSE_DECODE_ERROR',
      status: 502,
      statusCode: 502,
      retryable: true,
      requestExecutorProviderErrorStage: 'provider.sse_decode'
    });
  });

  it('remaps empty Anthropic SSE materialization failures to retryable SSE decode errors', () => {
    const error: Record<string, unknown> = { code: 'HTTP_HANDLER_ERROR' };
    const changed = remapBridgeSseErrorToHttp(
      error,
      'Rust HubPipeline response path failed: hub_pipeline_resp_anthropic_chat_canonicalize_failed: Anthropic SSE response did not contain materializable content blocks'
    );

    expect(changed).toBe(true);
    expect(error).toMatchObject({
      code: 'SSE_DECODE_ERROR',
      status: 502,
      statusCode: 502,
      retryable: true,
      requestExecutorProviderErrorStage: 'provider.sse_decode'
    });
  });
});
