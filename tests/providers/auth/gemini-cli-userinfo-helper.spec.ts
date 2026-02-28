import { afterEach, describe, expect, test } from '@jest/globals';

import { fetchGeminiCLIUserInfo } from '../../../src/providers/auth/gemini-cli-userinfo-helper.js';

describe('fetchGeminiCLIUserInfo', () => {
  const prevFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = prevFetch as typeof fetch;
  });

  test('retries transient network failure and succeeds', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) {
        const err = new Error('fetch failed') as Error & { cause?: unknown };
        err.cause = { code: 'EAI_AGAIN', message: 'temporary name resolution failure' };
        throw err;
      }
      return new Response(
        JSON.stringify({
          email: 'gemini@example.com',
          name: 'Gemini User',
          verified_email: true
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof fetch;

    const user = await fetchGeminiCLIUserInfo('token-value');
    expect(calls).toBe(2);
    expect(user.email).toBe('gemini@example.com');
    expect(user.name).toBe('Gemini User');
    expect(user.verified_email).toBe(true);
  });
});
