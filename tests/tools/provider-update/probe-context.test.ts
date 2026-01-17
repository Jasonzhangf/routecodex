import { buildTextForExactTokenCount, countTokens, probeContextForModel } from '../../../src/tools/provider-update/probe-context.js';

describe('provider-update/probe-context', () => {
  test('buildTextForExactTokenCount creates exact token count', () => {
    const text = buildTextForExactTokenCount(25, 'gpt-4o');
    expect(countTokens(text, 'gpt-4o')).toBe(25);
  });

  test('probeContextForModel stops at first failure', async () => {
    const thresholds = [10, 20, 30, 40];
    let calls = 0;
    const fetcher = async (_url: any, init: any) => {
      calls += 1;
      const parsed = JSON.parse(String(init?.body || '{}'));
      const text = parsed?.input?.[0]?.content?.[0]?.text || '';
      const tokens = countTokens(String(text), 'gpt-4o');
      if (tokens <= 20) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          text: async () => 'ok'
        } as any;
      }
      return {
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: async () => JSON.stringify({ error: { message: 'Prompt is too long' } })
      } as any;
    };

    const res = await probeContextForModel('claude-sonnet-4-5', thresholds, {
      endpoint: 'http://127.0.0.1:5555/v1/responses',
      apiKey: 'routecodex-test',
      fetcher,
      timeoutMs: 10_000,
      encoderModel: 'gpt-4o'
    });

    expect(res.passed).toEqual([10, 20]);
    expect(res.maxPassedTokens).toBe(20);
    expect(res.firstFailure?.threshold).toBe(30);
    expect(res.firstFailure?.status).toBe(400);
    expect(calls).toBe(3);
  });
});

