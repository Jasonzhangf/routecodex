import {
  buildUsageLogText,
  extractUsageFromResult
} from '../../../../../src/server/runtime/http-server/executor/usage-aggregator.js';

describe('usage log text', () => {
  it('prints request/response/total tokens with direct completion usage', () => {
    const text = buildUsageLogText({
      prompt_tokens: 120,
      completion_tokens: 45,
      total_tokens: 165
    });

    expect(text).toBe('request=120 response=45 total=165');
  });

  it('derives response tokens from total when completion is missing', () => {
    const text = buildUsageLogText({
      prompt_tokens: 200,
      total_tokens: 260
    });

    expect(text).toBe('request=200 response=60 total=260');
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
});
