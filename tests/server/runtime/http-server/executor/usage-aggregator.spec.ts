import {
  buildUsageLogText,
  extractUsageFromResult,
  mergeUsageMetrics
} from '../../../../../src/server/runtime/http-server/executor/usage-aggregator.js';

describe('usage log text', () => {
  it('prints input/output/total tokens with direct completion usage', () => {
    const text = buildUsageLogText({
      prompt_tokens: 120,
      completion_tokens: 45,
      total_tokens: 165
    });

    expect(text).toBe('input_tokens=120 output_tokens=45 total_tokens=165');
  });

  it('derives output tokens from total when completion is missing', () => {
    const text = buildUsageLogText({
      prompt_tokens: 200,
      total_tokens: 260
    });

    expect(text).toBe('input_tokens=200 output_tokens=60 total_tokens=260');
  });

  it('extracts usage from body.metadata.usage', () => {
    const usage = extractUsageFromResult({
      body: {
        metadata: {
          usage: {
            prompt_tokens: 11,
            completion_tokens: 7,
            total_tokens: 18
          }
        }
      }
    });

    expect(usage).toEqual({
      prompt_tokens: 11,
      completion_tokens: 7,
      total_tokens: 18
    });
  });

  it('normalizes camelCase/string usage fields', () => {
    const usage = extractUsageFromResult({
      body: {
        usage: {
          promptTokens: '120',
          outputTokens: '30',
          totalTokens: '150'
        }
      }
    });

    expect(usage).toEqual({
      prompt_tokens: 120,
      completion_tokens: 30,
      total_tokens: 150
    });
  });

  it('extracts usage from body.payload.usage', () => {
    const usage = extractUsageFromResult({
      body: {
        payload: {
          usage: {
            input_tokens: 559,
            output_tokens: 969,
            cache_read_input_tokens: 107392
          }
        }
      }
    });

    expect(usage).toEqual({
      prompt_tokens: 107951,
      completion_tokens: 969,
      total_tokens: 108920,
      cache_read_input_tokens: 107392,
      cache_creation_input_tokens: undefined
    });
  });

  it('recomputes total when cache tokens are excluded upstream', () => {
    const usage = extractUsageFromResult({
      body: {
        usage: {
          input_tokens: 77,
          output_tokens: 38,
          cache_read_input_tokens: 106944,
          total_tokens: 115
        }
      }
    });

    expect(usage).toEqual({
      prompt_tokens: 107021,
      completion_tokens: 38,
      total_tokens: 107059,
      cache_read_input_tokens: 106944,
      cache_creation_input_tokens: undefined
    });
  });

  it('extracts cache hits from DeepSeek prompt_cache_hit_tokens', () => {
    const usage = extractUsageFromResult({
      body: {
        usage: {
          prompt_tokens: 50000,
          completion_tokens: 200,
          total_tokens: 50200,
          prompt_cache_hit_tokens: 48000
        }
      }
    });

    expect(usage).toEqual({
      prompt_tokens: 50000,
      completion_tokens: 200,
      total_tokens: 50200,
      cache_read_input_tokens: 48000,
      cache_creation_input_tokens: undefined
    });
  });

  it('extracts cache hits from prompt_tokens_details.cached_tokens', () => {
    const usage = extractUsageFromResult({
      body: {
        usage: {
          prompt_tokens: 68992,
          completion_tokens: 395,
          total_tokens: 69387,
          prompt_tokens_details: {
            cached_tokens: 68539
          }
        }
      }
    });

    expect(usage).toEqual({
      prompt_tokens: 68992,
      completion_tokens: 395,
      total_tokens: 69387,
      cache_read_input_tokens: 68539,
      cache_creation_input_tokens: undefined
    });
  });

  it('extracts usage from body.payload.response.usage', () => {
    const usage = extractUsageFromResult({
      body: {
        payload: {
          response: {
            usage: {
              prompt_tokens: 10,
              completion_tokens: 5,
              total_tokens: 15
            }
          }
        }
      }
    });

    expect(usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15
    });
  });

  it('extracts gemini usageMetadata token counts', () => {
    const usage = extractUsageFromResult({
      body: {
        usageMetadata: {
          promptTokenCount: 42,
          candidatesTokenCount: 10,
          totalTokenCount: 52
        }
      }
    });

    expect(usage).toEqual({
      prompt_tokens: 42,
      completion_tokens: 10,
      total_tokens: 52
    });
  });

  it('extracts usage from provider response metadata bag', () => {
    const usage = extractUsageFromResult({
      body: {
        candidates: []
      },
      metadata: {
        usage: {
          usageMetadata: {
            promptTokenCount: 12,
            candidatesTokenCount: 7,
            totalTokenCount: 19
          }
        }
      }
    });

    expect(usage).toEqual({
      prompt_tokens: 12,
      completion_tokens: 7,
      total_tokens: 19
    });
  });

  it('prefers response usage and ignores metadata usage bag', () => {
    const usage = extractUsageFromResult(
      {
        body: {
          usage: {
            prompt_tokens: 20,
            completion_tokens: 8,
            total_tokens: 28
          }
        }
      },
      {
        usage: {
          prompt_tokens: 999999,
          completion_tokens: 1,
          total_tokens: 1000000
        },
        estimatedInputTokens: 777777
      }
    );

    expect(usage).toEqual({
      prompt_tokens: 20,
      completion_tokens: 8,
      total_tokens: 28
    });
  });

  it('does not fabricate usage from request metadata when response usage is absent', () => {
    const usage = extractUsageFromResult(
      {
        body: {
          message: 'ok'
        }
      },
      {
        usage: {
          prompt_tokens: 123,
          completion_tokens: 4,
          total_tokens: 127
        },
        estimatedInputTokens: 1000
      }
    );

    expect(usage).toBeUndefined();
  });

  it('merges cache read and cache creation tokens across usage snapshots', () => {
    const usage = mergeUsageMetrics(
      {
        prompt_tokens: 100,
        completion_tokens: 25,
        total_tokens: 125,
        cache_read_input_tokens: 80,
        cache_creation_input_tokens: 16
      },
      {
        prompt_tokens: 50,
        completion_tokens: 5,
        total_tokens: 55,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 4
      }
    );

    expect(usage).toEqual({
      prompt_tokens: 150,
      completion_tokens: 30,
      total_tokens: 180,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 20
    });
  });
});
