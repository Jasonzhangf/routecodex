import { describe, expect, it } from '@jest/globals';
import { classifyProviderError } from '../../../../src/providers/core/runtime/provider-error-classifier.js';

describe('Provider error classifier - 429 handling', () => {
  const baseContext = {
    requestId: 'req_test',
    providerKey: 'antigravity.alias1.gemini-3-pro-high',
    providerType: 'gemini',
    providerFamily: 'gemini',
    providerProtocol: 'gemini-chat',
    model: 'gemini-3-pro-high'
  } as any;

  it('treats 429 as recoverable via shared policy outcome', () => {
    const classification = classifyProviderError({
      error: Object.assign(new Error('HTTP 429: quota has been exhausted'), {
        response: {
          status: 429,
          data: { error: { status: 429, message: 'quota has been exhausted' } }
        }
      }),
      context: baseContext
    });

    expect(classification.isRateLimit).toBe(true);
    expect(classification.classification).toBe('recoverable');
    expect(classification.recoverable).toBe(true);
    expect(classification.affectsHealth).toBe(true);
  });
});

describe('Provider error classifier - internal conversion errors', () => {
  const baseContext = {
    requestId: 'req_test',
    providerKey: 'tab.key1.gpt-5.2-codex',
    providerType: 'openai',
    providerFamily: 'openai',
    providerProtocol: 'openai-responses',
    model: 'gpt-5.2-codex'
  } as any;

  it('treats SSE_TO_JSON_ERROR as recoverable and health-affecting via unified policy', () => {
    const error = Object.assign(new Error('SSE_TO_JSON_ERROR: terminated'), { code: 'SSE_TO_JSON_ERROR' });
    const classification = classifyProviderError({
      error,
      context: baseContext
    });

    expect(classification.recoverable).toBe(true);
    expect(classification.classification).toBe('recoverable');
    expect(classification.affectsHealth).toBe(true);
    expect(classification.isRateLimit).toBe(false);
  });

  it('treats client disconnect abort as non-recoverable and health-neutral', () => {
    const error = Object.assign(new Error('CLIENT_REQUEST_ABORTED'), {
      name: 'AbortError',
      code: 'CLIENT_DISCONNECTED'
    });
    const classification = classifyProviderError({
      error,
      context: baseContext
    });

    expect(classification.recoverable).toBe(false);
    expect(classification.classification).toBe('unrecoverable');
    expect(classification.affectsHealth).toBe(false);
    expect(classification.isRateLimit).toBe(false);
  });

  it('treats glm upstream 434 blocked-account as non-recoverable and health-affecting', () => {
    const error = Object.assign(
      new Error('HTTP 400: GLM business error (434): Access to the current AK has been blocked due to unauthorized requests'),
      {
        response: {
          status: 400,
          data: {
            upstream: {
              status: '434',
              msg: 'Access to the current AK has been blocked due to unauthorized requests'
            }
          }
        }
      }
    );
    const classification = classifyProviderError({
      error,
      context: baseContext
    });

    expect(classification.statusCode).toBe(434);
    expect(classification.recoverable).toBe(false);
    expect(classification.classification).toBe('unrecoverable');
    expect(classification.affectsHealth).toBe(true);
    expect(classification.isRateLimit).toBe(false);
  });
});
