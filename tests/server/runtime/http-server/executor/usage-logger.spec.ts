import { jest } from '@jest/globals';

describe('usage logger timing summary', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
    jest.restoreAllMocks();
  });

  it('appends timing summary to usage logs in dev after stages touched the request', async () => {
    process.env.NODE_ENV = 'development';
    const nowSpy = jest.spyOn(Date, 'now');
    nowSpy
      .mockReturnValueOnce(1000)
      .mockReturnValueOnce(1120);

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const { logPipelineStage } = await import('../../../../../src/server/utils/stage-logger.js');
    const { logUsageSummary } = await import('../../../../../src/server/runtime/http-server/executor/usage-logger.js');

    logPipelineStage('request.received', 'req_usage_timing', { endpoint: '/v1/responses' });
    logUsageSummary('req_usage_timing', {
      providerKey: 'demo.key1',
      model: 'demo-model',
      latencyMs: 120,
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    });

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[usage] request req_usage_timing'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('t+120ms Δ120ms'));
  });
});
