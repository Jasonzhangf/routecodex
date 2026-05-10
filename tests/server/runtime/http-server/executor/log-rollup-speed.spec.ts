import { jest } from '@jest/globals';

describe('log rollup realtime speed calculation', () => {
  const originalEnv = { ...process.env };

  afterEach(async () => {
    try {
      const { __resetLogRollupForTest } = await import('../../../../../src/server/runtime/http-server/executor/log-rollup.js');
      __resetLogRollupForTest();
    } catch {
      // ignore cleanup failure during module reset
    }
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
    jest.resetModules();
  });

  it('uses first-content to last-content window for speed and request-start to first-content for ttft', async () => {
    process.env.ROUTECODEX_LOG_ROLLUP = '1';
    process.env.ROUTECODEX_LOG_ROLLUP_REALTIME = '1';

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const { recordUsageRollup } = await import('../../../../../src/server/runtime/http-server/executor/log-rollup.js');

    recordUsageRollup({
      requestId: 'req-speed-window',
      routeName: 'thinking',
      poolId: 'thinking-long-lb',
      providerKey: 'demo.key1',
      model: 'demo-model',
      sessionId: 'sid-speed-window',
      projectPath: '/tmp/project-speed-window',
      latencyMs: 5_000,
      internalLatencyMs: 1_000,
      externalLatencyMs: 4_000,
      sseDecodeMs: 3_000,
      completionTokens: 100,
      totalTokens: 110,
      firstContentAtMs: 2_000,
      lastContentAtMs: 3_000,
      requestStartedAtMs: 1_000,
      finishReason: 'stop'
    });

    const lines = logSpy.mock.calls.map((call) => String(call[0] ?? ''));
    const tokenLine = lines.find((line) => line.includes('speed='));
    expect(tokenLine).toContain('out=100');
    expect(tokenLine).toContain('speed=100t/s');
    expect(tokenLine).toContain('ttft=1000ms');
  });

  it('falls back to sseDecodeMs when first/last content timing is unavailable', async () => {
    process.env.ROUTECODEX_LOG_ROLLUP = '1';
    process.env.ROUTECODEX_LOG_ROLLUP_REALTIME = '1';

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const { recordUsageRollup } = await import('../../../../../src/server/runtime/http-server/executor/log-rollup.js');

    recordUsageRollup({
      requestId: 'req-speed-sse-fallback',
      routeName: 'thinking',
      poolId: 'thinking-long-lb',
      providerKey: 'demo.key1',
      model: 'demo-model',
      sessionId: 'sid-speed-fallback',
      projectPath: '/tmp/project-speed-fallback',
      latencyMs: 8_000,
      internalLatencyMs: 4_000,
      externalLatencyMs: 4_000,
      sseDecodeMs: 2_000,
      completionTokens: 100,
      totalTokens: 110,
      finishReason: 'stop'
    });

    const lines = logSpy.mock.calls.map((call) => String(call[0] ?? ''));
    const tokenLine = lines.find((line) => line.includes('speed='));
    expect(tokenLine).toContain('speed=50t/s');
  });
});
