import { jest } from '@jest/globals';

describe('log rollup', () => {
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

  it('flushes 1-minute virtual-router and usage summaries', async () => {
    process.env.ROUTECODEX_LOG_ROLLUP = '1';
    process.env.ROUTECODEX_LOG_ROLLUP_REALTIME = '0';
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const {
      recordVirtualRouterHitRollup,
      recordUsageRollup,
      flushLogRollup
    } = await import('../../../../../src/server/runtime/http-server/executor/log-rollup.js');

    recordVirtualRouterHitRollup({
      routeName: 'default',
      poolId: 'tools-primary',
      providerKey: 'qwen.1',
      model: 'qwen3.6-plus',
      sessionId: 'sid-a',
      projectPath: '/tmp/project-a',
      activeInFlight: 1,
      maxInFlight: 4
    });
    recordVirtualRouterHitRollup({
      routeName: 'default',
      poolId: 'tools-primary',
      providerKey: 'qwen.1',
      model: 'qwen3.6-plus',
      sessionId: 'sid-a',
      projectPath: '/tmp/project-a',
      activeInFlight: 2,
      maxInFlight: 4
    });

    recordUsageRollup({
      requestId: 'req-a-1',
      routeName: 'default',
      poolId: 'tools-primary',
      providerKey: 'qwen.1',
      model: 'qwen3.6-plus',
      sessionId: 'sid-a',
      projectPath: '/tmp/project-a',
      latencyMs: 1000,
      internalLatencyMs: 450,
      externalLatencyMs: 550,
      trafficWaitMs: 80,
      clientInjectWaitMs: 20,
      providerAttemptCount: 2,
      retryCount: 1,
      finishReason: 'tool_calls'
    });
    recordUsageRollup({
      requestId: 'req-a-2',
      routeName: 'default',
      poolId: 'tools-primary',
      providerKey: 'qwen.1',
      model: 'qwen3.6-plus',
      sessionId: 'sid-a',
      projectPath: '/tmp/project-a',
      latencyMs: 1200,
      internalLatencyMs: 550,
      externalLatencyMs: 650,
      trafficWaitMs: 20,
      clientInjectWaitMs: 30,
      providerAttemptCount: 1,
      retryCount: 0,
      finishReason: 'stop'
    });

    flushLogRollup('manual');
    const lines = logSpy.mock.calls.map((call) => String(call[0] ?? ''));
    expect(lines.some((line) => line.includes('[virtual-router-hit][1m]'))).toBe(true);
    expect(lines.some((line) => line.includes('provider=qwen.1.qwen3.6-plus hits=2'))).toBe(true);
    expect(lines.some((line) => line.includes('concurrency avg=1.50/4.00'))).toBe(true);
    expect(lines.some((line) => line.includes('[usage][1m]'))).toBe(true);
    expect(lines.some((line) => line.includes('avg.total=1100ms'))).toBe(true);
    expect(lines.some((line) => line.includes('avg.internal=500ms'))).toBe(true);
    expect(lines.some((line) => line.includes('avg.external=600ms'))).toBe(true);
    expect(lines.some((line) => line.includes('avg.retries=0.50 avg.attempts=1.50'))).toBe(true);
    expect(lines.some((line) => line.includes('avg.wait.traffic=50ms avg.wait.inject=25ms'))).toBe(true);
    expect(lines.some((line) => line.includes('avg.core_internal=425ms'))).toBe(true);
    expect(lines.some((line) => line.includes('max.total=1200ms'))).toBe(true);
    expect(lines.some((line) => line.includes('[session-rollup][1m]'))).toBe(true);
    expect(lines.some((line) => line.includes('session=sid-a'))).toBe(true);
    expect(lines.some((line) => line.includes('project=/tmp/project-a'))).toBe(true);
    expect(lines.some((line) => line.includes('[session-requests][1m]'))).toBe(true);
    const reqLine1 = lines.find((line) => line.includes('req=req-a-1'));
    const reqLine2 = lines.find((line) => line.includes('req=req-a-2'));
    expect(reqLine1).toBeDefined();
    expect(reqLine2).toBeDefined();
    expect(reqLine1).toContain('\x1b[97mfinish_reason=tool_calls\x1b[0m');
    expect(reqLine2).toContain('\x1b[97mfinish_reason=stop\x1b[0m');
    const reqIndex1 = lines.findIndex((line) => line.includes('req=req-a-1'));
    const reqIndex2 = lines.findIndex((line) => line.includes('req=req-a-2'));
    expect(reqIndex1).toBeLessThan(reqIndex2);
  });

  it('limits rollup output with topN and prints others summary', async () => {
    process.env.ROUTECODEX_LOG_ROLLUP = '1';
    process.env.ROUTECODEX_LOG_ROLLUP_REALTIME = '0';
    process.env.ROUTECODEX_LOG_ROLLUP_TOP_N = '1';
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const {
      recordVirtualRouterHitRollup,
      recordUsageRollup,
      flushLogRollup
    } = await import('../../../../../src/server/runtime/http-server/executor/log-rollup.js');

    recordVirtualRouterHitRollup({
      routeName: 'default',
      poolId: 'p1',
      providerKey: 'provider.a',
      model: 'm1',
      sessionId: 'sid-1',
      activeInFlight: 3,
      maxInFlight: 4
    });
    recordVirtualRouterHitRollup({
      routeName: 'default',
      poolId: 'p2',
      providerKey: 'provider.b',
      model: 'm2',
      sessionId: 'sid-2',
      activeInFlight: 1,
      maxInFlight: 2
    });
    recordUsageRollup({
      requestId: 'req-1',
      routeName: 'default',
      poolId: 'p1',
      providerKey: 'provider.a',
      model: 'm1',
      sessionId: 'sid-1',
      latencyMs: 900,
      internalLatencyMs: 300,
      externalLatencyMs: 600
    });
    recordUsageRollup({
      requestId: 'req-2',
      routeName: 'default',
      poolId: 'p2',
      providerKey: 'provider.b',
      model: 'm2',
      sessionId: 'sid-2',
      latencyMs: 500,
      internalLatencyMs: 200,
      externalLatencyMs: 300
    });

    flushLogRollup('manual');
    const lines = logSpy.mock.calls.map((call) => String(call[0] ?? ''));
    expect(lines.some((line) => line.includes('others)'))).toBe(true);
    expect(lines.some((line) => line.includes('groups=1 hits=1'))).toBe(true);
    expect(lines.some((line) => line.includes('groups=1 calls=1'))).toBe(true);
    expect(lines.some((line) => line.includes('groups=1 virtual_hits=1 usage_calls=1'))).toBe(true);
  });

  it('skips rollup output when there are no usage calls', async () => {
    process.env.ROUTECODEX_LOG_ROLLUP = '1';
    process.env.ROUTECODEX_LOG_ROLLUP_REALTIME = '0';
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const {
      recordVirtualRouterHitRollup,
      flushLogRollup
    } = await import('../../../../../src/server/runtime/http-server/executor/log-rollup.js');

    recordVirtualRouterHitRollup({
      routeName: 'default',
      poolId: 'tools-primary',
      providerKey: 'qwen.1',
      model: 'qwen3.6-plus',
      sessionId: 'sid-a',
      projectPath: '/tmp/project-a',
      activeInFlight: 1,
      maxInFlight: 1
    });

    flushLogRollup('manual');
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('prints virtual-router-hit in realtime mode and suppresses 1m rollup', async () => {
    process.env.ROUTECODEX_LOG_ROLLUP = '1';
    process.env.ROUTECODEX_LOG_ROLLUP_REALTIME = '1';
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const { recordVirtualRouterHitRollup, flushLogRollup } = await import(
      '../../../../../src/server/runtime/http-server/executor/log-rollup.js'
    );

    recordVirtualRouterHitRollup({
      routeName: 'tools',
      poolId: 'tools-primary',
      providerKey: 'ali-coding-plan.key1.glm-5',
      model: 'glm-5',
      sessionId: 'sid-rt-1',
      projectPath: '/tmp/project-rt',
      activeInFlight: 2,
      maxInFlight: 6
    });
    flushLogRollup('manual');

    const lines = logSpy.mock.calls.map((call) => String(call[0] ?? ''));
    expect(lines.some((line) => line.includes('[virtual-router-hit][rt]'))).toBe(true);
    expect(lines.some((line) => line.includes('tools/tools-primary -> ali-coding-plan.key1.glm-5.glm-5'))).toBe(true);
    expect(lines.some((line) => line.includes('[concurrency:2/6]'))).toBe(true);
    expect(lines.some((line) => line.includes('session.virtual_hits=1'))).toBe(true);
    expect(lines.some((line) => line.includes('[rollup][1m]'))).toBe(false);
    expect(lines.some((line) => line.includes('[virtual-router-hit][1m]'))).toBe(false);
    expect(lines.some((line) => line.includes('[usage][1m]'))).toBe(false);
  });
});
