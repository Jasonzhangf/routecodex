import { jest } from '@jest/globals';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

describe('usage logger timing summary', () => {
  const originalEnv = { ...process.env };

  afterEach(async () => {
    try {
      const { __resetLogRollupForTest } = await import('../../../../../src/server/runtime/http-server/executor/log-rollup.js');
      __resetLogRollupForTest();
    } catch {
      // ignore dynamic import failures during module reset
    }
    try {
      const { __resetTokenStatsForTest } = await import('../../../../../src/server/runtime/http-server/executor/token-stats-store.js');
      __resetTokenStatsForTest();
    } catch {
      // ignore dynamic import failures during module reset
    }
    process.env = { ...originalEnv };
    jest.resetModules();
    jest.restoreAllMocks();
  });

  it('appends request timing summary in dev when summary mode is enabled', async () => {
    process.env.NODE_ENV = 'development';
    process.env.ROUTECODEX_BUILD_MODE = 'dev';
    process.env.ROUTECODEX_STAGE_TIMING_SUMMARY = '1';
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
      finishReason: 'stop',
      latencyMs: 120,
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    });

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[usage] req='));
  });

  it('prints cumulative token totals without requiring hot-path sync writes', async () => {
    const fakeHome = path.join(os.tmpdir(), `usage-logger-token-stats-${process.pid}-${randomUUID()}`);
    const homedirSpy = jest.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    const writeFileSyncSpy = jest.spyOn(fsSync, 'writeFileSync');
    const writeDir = path.join(fakeHome, '.rcc');
    const statsPath = path.join(writeDir, 'token-stats.json');

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const { logUsageSummary } = await import('../../../../../src/server/runtime/http-server/executor/usage-logger.js');
    const { flushTokenStats } = await import('../../../../../src/server/runtime/http-server/executor/token-stats-store.js');

    logUsageSummary('req_tokens_1', {
      providerKey: 'demo.key1',
      model: 'demo-model',
      finishReason: 'stop',
      latencyMs: 120,
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    });
    logUsageSummary('req_tokens_2', {
      providerKey: 'demo.key1',
      model: 'demo-model',
      finishReason: 'stop',
      latencyMs: 130,
      usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 }
    });

    const rendered = String(logSpy.mock.calls.at(-1)?.[0] ?? '');
    const plain = rendered.replace(/\u001b\[[0-9;]*m/g, '');
    expect(plain).toContain('[usage] req=');
    expect(plain).toContain('total=10');
    expect(writeFileSyncSpy).not.toHaveBeenCalled();

    flushTokenStats();
    const persisted = JSON.parse(await fs.readFile(statsPath, 'utf8'));
    expect(persisted.version).toBe(2);
    const sessions = Object.values(persisted.sessions ?? {}) as Array<{
      alltime: Record<string, unknown>;
      providers: Record<string, Record<string, unknown>>;
    }>;
    expect(sessions).toHaveLength(1);
    expect(sessions[0].alltime.totalTokens).toBe(25);
    expect(sessions[0].providers?.['demo.key1|demo-model']?.totalTokens).toBe(25);

    await fs.rm(fakeHome, { recursive: true, force: true });
    homedirSpy.mockRestore();
  });

  it('records token totals even when finishReason is tool_calls', async () => {
    const fakeHome = path.join(os.tmpdir(), `usage-logger-tool-calls-${process.pid}-${randomUUID()}`);
    const homedirSpy = jest.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const { logUsageSummary } = await import('../../../../../src/server/runtime/http-server/executor/usage-logger.js');
    const { getTokenTotals } = await import('../../../../../src/server/runtime/http-server/executor/token-stats-store.js');

    logUsageSummary('req_tokens_tool_calls', {
      providerKey: 'demo.key1',
      model: 'demo-model',
      finishReason: 'tool_calls',
      latencyMs: 120,
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    });

    const lines = logSpy.mock.calls.map((call) => String(call[0] ?? ''));
    expect(getTokenTotals()).toEqual({ alltimeTokens: 15, dailyTokens: 15 });
    expect(lines.some((line) => line.includes('[usage] req='))).toBe(true);

    await fs.rm(fakeHome, { recursive: true, force: true });
    homedirSpy.mockRestore();
  });

  it('resets local daily stats by local midnight instead of utc midnight', async () => {
    const { resolveLocalDayKey } = await import('../../../../../src/server/runtime/http-server/executor/usage-logger.js');

    const first = new Date('2026-06-20T16:30:00.000Z');
    const second = new Date('2026-06-20T17:10:00.000Z');

    expect(resolveLocalDayKey(first)).toBe(resolveLocalDayKey(second));
  });

  it('uses request session color for every usage line before tmux id', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const { logUsageSummary } = await import('../../../../../src/server/runtime/http-server/executor/usage-logger.js');
    const { resolveSessionAnsiColor } = await import('../../../../../src/utils/session-log-color.js');

    const tmuxSessionId = 'tmux-usage-color-stable';
    const tmuxColor = resolveSessionAnsiColor(tmuxSessionId);
    let requestSessionId = 'usage-per-request-session';
    for (let index = 0; index < 64 && resolveSessionAnsiColor(requestSessionId) === tmuxColor; index += 1) {
      requestSessionId = `usage-per-request-session-${index}`;
    }
    const expectedColor = resolveSessionAnsiColor(requestSessionId);

    logUsageSummary('req_usage_color', {
      providerKey: 'demo.key1',
      model: 'demo-model',
      requestModel: 'gpt-5',
      routeName: 'tools',
      poolId: 'tools-primary',
      entryPort: 5555,
      finishReason: 'stop',
      latencyMs: 120,
      clientTmuxSessionId: tmuxSessionId,
      sessionId: requestSessionId,
      projectPath: '/tmp/demo-project',
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    });

    const rendered = String(logSpy.mock.calls.at(-1)?.[0] ?? '');
    const renderedLines = rendered.split('\n');
    expect(expectedColor).toBeDefined();
    expect(tmuxColor).toBeDefined();
    expect(expectedColor).not.toBe(tmuxColor);
    expect(renderedLines.length).toBeGreaterThan(0);
    for (const line of renderedLines) {
      expect(line.startsWith(String(expectedColor))).toBe(true);
      expect(line.startsWith(String(tmuxColor))).toBe(false);
    }
    expect(renderedLines).toHaveLength(1);
    expect(rendered).toContain('finish_reason=\x1b[97mstop');
    expect(rendered).toContain('project=/tmp/demo-project:5555');
    expect(rendered).toContain('route=tools');
    expect(rendered).toContain('model=gpt-5->demo-model');
    expect(rendered).toContain('\x1b[97m');
  });

  it('does not recolor virtual-router-hit or usage lines when request has no session key', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const { colorizeVirtualRouterHitLogLine, registerRequestLogContext } = await import('../../../../../src/server/utils/request-log-color.js');
    const { logUsageSummary } = await import('../../../../../src/server/runtime/http-server/executor/usage-logger.js');

    const requestId = 'openai-responses-router-gpt-5.5-20260704T162136689-458956-727';
    const routeColor = '\x1b[38;5;141m';
    registerRequestLogContext(requestId, { clientRequestId: '8958-729' });
    const routerHitLine = colorizeVirtualRouterHitLogLine(
      `${routeColor}[virtual-router-hit]\x1b[0m \x1b[90m16:21:36\x1b[0m req=${requestId} ${routeColor}longcontext/gateway-priority-5555-priority-longcontext -> orangeai[key1].glm-5.2 reason=longcontext:token-threshold\x1b[0m`
    );
    expect(routerHitLine.startsWith(routeColor)).toBe(true);
    expect(routerHitLine).toContain(`${routeColor}longcontext/gateway-priority-5555-priority-longcontext`);

    logUsageSummary(requestId, {
      providerKey: 'orangeai.key1',
      model: 'glm-5.2',
      requestModel: 'gpt-5.5',
      routeName: 'longcontext',
      poolId: 'gateway-priority-5555-priority-longcontext',
      entryPort: 5555,
      latencyMs: 120,
      clientRequestId: '8958-729',
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    });

    const rendered = String(logSpy.mock.calls.at(-1)?.[0] ?? '');
    expect(rendered.startsWith(routeColor)).toBe(false);
    expect(rendered.startsWith('\x1b')).toBe(false);
    expect(rendered).toContain('route=longcontext');
    expect(rendered).toContain('model=gpt-5.5->glm-5.2');
  });

  it('does not repeat finish_reason inside usage detail block', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const { logUsageSummary } = await import('../../../../../src/server/runtime/http-server/executor/usage-logger.js');

    logUsageSummary('req_usage_no_repeat_finish', {
      providerKey: 'demo.key1',
      model: 'demo-model',
      routeName: 'coding',
      poolId: 'coding-primary',
      finishReason: 'tool_calls',
      latencyMs: 120,
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    });

    const rendered = String(logSpy.mock.calls.at(-1)?.[0] ?? '');
    const plain = rendered.replace(/\u001b\[[0-9;]*m/g, '');
    const matches = plain.match(/finish_reason=tool_calls/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it('does not synthesize finish_reason=unknown when no terminal reason is available', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const { logUsageSummary } = await import('../../../../../src/server/runtime/http-server/executor/usage-logger.js');

    logUsageSummary('req_usage_missing_finish', {
      providerKey: 'demo.key1',
      model: 'demo-model',
      routeName: 'coding',
      poolId: 'coding-primary',
      latencyMs: 120,
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    });

    const rendered = String(logSpy.mock.calls.at(-1)?.[0] ?? '');
    const plain = rendered.replace(/\u001b\[[0-9;]*m/g, '');
    expect(plain).toContain('[usage] req=');
    expect(plain).not.toContain('finish_reason=unknown');
    expect(plain).not.toContain('finish_reason=');
  });

  it('does not print n/a usage placeholders when upstream usage is absent', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const { logUsageSummary } = await import('../../../../../src/server/runtime/http-server/executor/usage-logger.js');

    logUsageSummary('req_usage_missing_tokens', {
      providerKey: 'demo.key1',
      model: 'demo-model',
      routeName: 'coding',
      poolId: 'coding-primary',
      finishReason: 'stop',
      latencyMs: 120
    });

    const rendered = String(logSpy.mock.calls.at(-1)?.[0] ?? '');
    const plain = rendered.replace(/\u001b\[[0-9;]*m/g, '');
    expect(plain).toContain('[usage] req=');
    expect(plain).toContain('finish_reason=stop');
    expect(plain).not.toContain('usage=in:n/a');
    expect(plain).not.toContain('out:n/a');
    expect(plain).not.toContain('cache=n/a/n/a');
    expect(plain).not.toContain('total=n/a');
    expect(plain).toContain('usage=unreported');
  });

  it('keeps usage detail logging free of request metadata noise', async () => {
    process.env.NODE_ENV = 'development';
    process.env.ROUTECODEX_BUILD_MODE = 'release';
    process.env.ROUTECODEX_USAGE_TIMING = '1';

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const { logPipelineStage } = await import('../../../../../src/server/utils/stage-logger.js');
    const { logUsageSummary } = await import('../../../../../src/server/runtime/http-server/executor/usage-logger.js');

    logPipelineStage('hub.start', 'req_usage_noise_slim', {});
    logPipelineStage('hub.completed', 'req_usage_noise_slim', { elapsedMs: 140 });
    logPipelineStage('provider.send.start', 'req_usage_noise_slim', {});
    logPipelineStage('provider.send.completed', 'req_usage_noise_slim', { elapsedMs: 800 });
    logPipelineStage('response.dispatch.start', 'req_usage_noise_slim', { status: 200, stream: false });
    logPipelineStage('response.completed', 'req_usage_noise_slim', { elapsedMs: 20 });

    logUsageSummary('req_usage_noise_slim', {
      providerKey: 'demo.key1',
      model: 'demo-model',
      providerRequestId: 'provider-sample-1',
      inputRequestId: 'input-sample-1',
      providerAttemptCount: 3,
      retryCount: 2,
      finishReason: 'stop',
      latencyMs: 1100,
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    });
    logUsageSummary('req_usage_noise_slim', {
      providerKey: 'demo.key1',
      model: 'demo-model',
      providerRequestId: 'provider-sample-2',
      inputRequestId: 'input-sample-2',
      providerAttemptCount: 3,
      retryCount: 2,
      finishReason: 'stop',
      latencyMs: 1100,
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    });

    const rendered = String(logSpy.mock.calls.at(-1)?.[0] ?? '');
    const plain = rendered.replace(/\u001b\[[0-9;]*m/g, '');
    expect(plain).toContain('request.internal=140ms');
    expect(plain).toContain('hub=140ms');
    expect(plain).toContain('provider.send=800ms');
    expect(plain).not.toContain('sample=');
    expect(plain).not.toContain('attempts=');
    expect(plain).not.toContain('retries=');
    expect(plain).not.toContain('day.calls=');
    expect(plain).not.toContain('req=req_');
  });

  it('prints cache read and cache write metrics in realtime session token line', async () => {
    process.env.ROUTECODEX_LOG_ROLLUP = '1';
    process.env.ROUTECODEX_LOG_ROLLUP_REALTIME = '1';

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const { logUsageSummary } = await import('../../../../../src/server/runtime/http-server/executor/usage-logger.js');

    logUsageSummary('req_cache_metrics', {
      providerKey: 'deepseek-web.2',
      model: 'deepseek-v4-pro',
      routeName: 'thinking',
      poolId: 'thinking-deepseek-web-primary',
      finishReason: 'stop',
      latencyMs: 5000,
      externalLatencyMs: 2000,
      sseDecodeMs: 1000,
      providerAttemptCount: 1,
      retryCount: 0,
      sessionId: 'sid-cache-metrics',
      projectPath: '/tmp/cache-metrics-project',
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 250,
        total_tokens: 1250,
        cache_read_input_tokens: 800,
        cache_creation_input_tokens: 120
      }
    });

    const lines = logSpy.mock.calls.map((call) => String(call[0] ?? ''));
    expect(lines.some((line) => line.includes('[session-request][rt] session=sid-cache-metrics'))).toBe(false);
    expect(lines.some((line) => line.includes('[usage] req='))).toBe(true);
    expect(lines.some((line) => line.replace(/\u001b\[[0-9;]*m/g, '').includes('cache=800/1000(80.0%)'))).toBe(true);
  });

  it('prints protocol-aware cache hit for openai responses usage lines', async () => {
    process.env.ROUTECODEX_LOG_ROLLUP = '1';
    process.env.ROUTECODEX_LOG_ROLLUP_REALTIME = '1';

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const { logUsageSummary } = await import('../../../../../src/server/runtime/http-server/executor/usage-logger.js');

    logUsageSummary('req_cache_openai_responses', {
      providerKey: 'demo.key1',
      providerProtocol: 'openai-responses',
      model: 'demo-model',
      routeName: 'tools',
      poolId: 'tools-primary',
      finishReason: 'stop',
      latencyMs: 120,
      usage: {
        prompt_tokens: 29056,
        completion_tokens: 100,
        total_tokens: 29156,
        cache_read_input_tokens: 29056
      }
    });

    const rendered = String(logSpy.mock.calls.at(-1)?.[0] ?? '');
    const plain = rendered.replace(/\u001b\[[0-9;]*m/g, '');
    expect(plain).toContain('cache=29056/29056(100.0%)');
  });


  it('prints breakdown in dev usage summary when summary mode is enabled and scoped timings exist', async () => {
    process.env.NODE_ENV = 'development';
    process.env.ROUTECODEX_BUILD_MODE = 'dev';
    process.env.ROUTECODEX_STAGE_TIMING_SUMMARY = '1';

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const { logPipelineStage } = await import('../../../../../src/server/utils/stage-logger.js');
    const { logUsageSummary } = await import('../../../../../src/server/runtime/http-server/executor/usage-logger.js');

    logPipelineStage('hub.start', 'req_dev_breakdown', {});
    logPipelineStage('hub.completed', 'req_dev_breakdown', { elapsedMs: 140 });
    logPipelineStage('provider.send.start', 'req_dev_breakdown', {});
    logPipelineStage('provider.send.completed', 'req_dev_breakdown', { elapsedMs: 800 });
    logPipelineStage('hub.response.start', 'req_dev_breakdown', {});
    logPipelineStage('hub.response.completed', 'req_dev_breakdown', { elapsedMs: 40 });
    logPipelineStage('response.dispatch.start', 'req_dev_breakdown', { status: 200, stream: false });
    logPipelineStage('response.completed', 'req_dev_breakdown', { elapsedMs: 20 });

    logUsageSummary('req_dev_breakdown', {
      providerKey: 'demo.key1',
      model: 'demo-model',
      finishReason: 'stop',
      latencyMs: 1100,
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    });

    const rendered = String(logSpy.mock.calls.at(-1)?.[0] ?? '');
    const plain = rendered.replace(/\u001b\[[0-9;]*m/g, '');
    expect(plain).toContain('request.internal=100ms');
    expect(plain).toContain('hub=140ms');
    expect(plain).toContain('provider.send=800ms');
    expect(plain).not.toContain('hub.response=40ms');
    expect(plain).not.toContain('response=20ms');
    expect(rendered).toContain('request.internal=\x1b[97m100ms');
    expect(rendered).toContain('provider.send=\x1b[97m800ms');
    expect(rendered).toContain('\x1b[97m');
  });

  it('does not print timing/hub.top in release by default', async () => {
    process.env.ROUTECODEX_BUILD_MODE = 'release';
    delete process.env.ROUTECODEX_USAGE_TIMING;
    delete process.env.ROUTECODEX_STAGE_LOG;
    delete process.env.ROUTECODEX_STAGE_TIMING;
    delete process.env.ROUTECODEX_STAGE_TIMING_SUMMARY;

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const { logPipelineStage } = await import('../../../../../src/server/utils/stage-logger.js');
    const { logUsageSummary } = await import('../../../../../src/server/runtime/http-server/executor/usage-logger.js');

    logPipelineStage('hub.start', 'req_release_no_timing', {});
    logPipelineStage('hub.completed', 'req_release_no_timing', { elapsedMs: 200 });
    logPipelineStage('provider.send.start', 'req_release_no_timing', {});
    logPipelineStage('provider.send.completed', 'req_release_no_timing', { elapsedMs: 500 });
    logPipelineStage('response.dispatch.start', 'req_release_no_timing', { status: 200, stream: false });
    logPipelineStage('response.completed', 'req_release_no_timing', { elapsedMs: 20 });

    logUsageSummary('req_release_no_timing', {
      providerKey: 'demo.key1',
      model: 'demo-model',
      finishReason: 'stop',
      latencyMs: 720,
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      hubStageTop: [
        { stage: 'req_inbound.stage2_semantic_map', totalMs: 700, count: 1 }
      ]
    });

    const rendered = String(logSpy.mock.calls.at(-1)?.[0] ?? '');
    expect(rendered).toContain('[usage] req=');
    expect(rendered).not.toContain('timing={');
    expect(rendered).not.toContain('hub.top=');
  });

  it('appends release stage breakdown to usage logs without extra env', async () => {
    process.env.ROUTECODEX_BUILD_MODE = 'release';
    process.env.ROUTECODEX_USAGE_TIMING = '1';
    delete process.env.ROUTECODEX_STAGE_LOG;
    delete process.env.ROUTECODEX_STAGE_TIMING;
    delete process.env.ROUTECODEX_STAGE_TIMING_SUMMARY;

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const { logPipelineStage } = await import('../../../../../src/server/utils/stage-logger.js');
    const { logUsageSummary } = await import('../../../../../src/server/runtime/http-server/executor/usage-logger.js');

    logPipelineStage('hub.start', 'req_release_usage', {});
    logPipelineStage('hub.completed', 'req_release_usage', { elapsedMs: 300 });
    logPipelineStage('provider.send.start', 'req_release_usage', {});
    logPipelineStage('provider.send.completed', 'req_release_usage', { elapsedMs: 600 });
    logPipelineStage('hub.response.start', 'req_release_usage', {});
    logPipelineStage('hub.response.completed', 'req_release_usage', { elapsedMs: 100 });
    logPipelineStage('response.dispatch.start', 'req_release_usage', { status: 200, stream: false });
    logPipelineStage('response.completed', 'req_release_usage', { elapsedMs: 25 });

    logUsageSummary('req_release_usage', {
      providerKey: 'demo.key1',
      model: 'demo-model',
      finishReason: 'stop',
      latencyMs: 1025,
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    });

    const rendered = String(logSpy.mock.calls.at(-1)?.[0] ?? '');
    expect(rendered).toContain('[usage] req=');
    expect(rendered.replace(/\u001b\[[0-9;]*m/g, '')).toContain('t:1025.0ms');
    expect(rendered).not.toContain('timing={');
    const plain = rendered.replace(/\u001b\[[0-9;]*m/g, '');
    expect(plain).not.toContain('request.internal=0ms');
    expect(plain).toContain('hub=300ms');
    expect(plain).toContain('provider.send=600ms');
    expect(plain).toContain('hub.response=100ms');
    expect(plain).not.toContain('response=25ms');
  });

  it('accumulates repeated scope timings in release usage summary', async () => {
    process.env.ROUTECODEX_BUILD_MODE = 'release';
    process.env.ROUTECODEX_USAGE_TIMING = '1';
    delete process.env.ROUTECODEX_STAGE_LOG;
    delete process.env.ROUTECODEX_STAGE_TIMING;
    delete process.env.ROUTECODEX_STAGE_TIMING_SUMMARY;

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const { logPipelineStage } = await import('../../../../../src/server/utils/stage-logger.js');
    const { logUsageSummary } = await import('../../../../../src/server/runtime/http-server/executor/usage-logger.js');

    logPipelineStage('hub.start', 'req_release_retry', {});
    logPipelineStage('hub.completed', 'req_release_retry', { elapsedMs: 100 });
    logPipelineStage('provider.send.start', 'req_release_retry', {});
    logPipelineStage('provider.send.completed', 'req_release_retry', { elapsedMs: 400 });
    logPipelineStage('hub.start', 'req_release_retry', {});
    logPipelineStage('hub.completed', 'req_release_retry', { elapsedMs: 50 });
    logPipelineStage('provider.send.start', 'req_release_retry', {});
    logPipelineStage('provider.send.completed', 'req_release_retry', { elapsedMs: 300 });
    logPipelineStage('hub.response.start', 'req_release_retry', {});
    logPipelineStage('hub.response.completed', 'req_release_retry', { elapsedMs: 40 });
    logPipelineStage('response.dispatch.start', 'req_release_retry', { status: 200, stream: false });
    logPipelineStage('response.completed', 'req_release_retry', { elapsedMs: 10 });

    logUsageSummary('req_release_retry', {
      providerKey: 'demo.key1',
      model: 'demo-model',
      finishReason: 'stop',
      latencyMs: 1000,
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    });

    const rendered = String(logSpy.mock.calls.at(-1)?.[0] ?? '');
    const plain = rendered.replace(/\u001b\[[0-9;]*m/g, '');
    expect(plain).toContain('request.internal=100ms');
    expect(plain).toContain('hub=150ms');
    expect(plain).toContain('provider.send=700ms');
    expect(plain).not.toContain('hub.response=40ms');
    expect(plain).not.toContain('response=10ms');
  });

  it('aggregates timing from multiple request ids in release usage summary', async () => {
    process.env.ROUTECODEX_BUILD_MODE = 'release';
    process.env.ROUTECODEX_USAGE_TIMING = '1';
    delete process.env.ROUTECODEX_STAGE_LOG;
    delete process.env.ROUTECODEX_STAGE_TIMING;
    delete process.env.ROUTECODEX_STAGE_TIMING_SUMMARY;

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const { logPipelineStage } = await import('../../../../../src/server/utils/stage-logger.js');
    const { logUsageSummary } = await import('../../../../../src/server/runtime/http-server/executor/usage-logger.js');

    logPipelineStage('hub.start', 'req_base', {});
    logPipelineStage('hub.completed', 'req_base', { elapsedMs: 120 });
    logPipelineStage('provider.send.start', 'req_final', {});
    logPipelineStage('provider.send.completed', 'req_final', { elapsedMs: 700 });
    logPipelineStage('hub.response.start', 'req_final', {});
    logPipelineStage('hub.response.completed', 'req_final', { elapsedMs: 30 });
    logPipelineStage('response.dispatch.start', 'req_final', { status: 200, stream: false });
    logPipelineStage('response.completed', 'req_final', { elapsedMs: 5 });

    logUsageSummary('req_final', {
      providerKey: 'demo.key1',
      model: 'demo-model',
      finishReason: 'stop',
      latencyMs: 1000,
      timingRequestIds: ['req_base', 'req_final'],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    });

    const rendered = String(logSpy.mock.calls.at(-1)?.[0] ?? '');
    const plain = rendered.replace(/\u001b\[[0-9;]*m/g, '');
    expect(plain).toContain('request.internal=145ms');
    expect(plain).toContain('hub=120ms');
    expect(plain).toContain('provider.send=700ms');
    expect(plain).not.toContain('hub.response=30ms');
    expect(plain).not.toContain('response=5ms');
  });

  it('keeps release timing available for usage after non-stream request complete log', async () => {
    process.env.ROUTECODEX_BUILD_MODE = 'release';
    process.env.ROUTECODEX_USAGE_TIMING = '1';
    process.env.ROUTECODEX_HTTP_LOG_VERBOSE = '1';
    delete process.env.ROUTECODEX_STAGE_LOG;
    delete process.env.ROUTECODEX_STAGE_TIMING;
    delete process.env.ROUTECODEX_STAGE_TIMING_SUMMARY;

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const { logPipelineStage } = await import('../../../../../src/server/utils/stage-logger.js');
    const { logRequestComplete } = await import('../../../../../src/server/handlers/handler-utils.js');
    const { logUsageSummary } = await import('../../../../../src/server/runtime/http-server/executor/usage-logger.js');

    logPipelineStage('hub.start', 'req_release_preserve', {});
    logPipelineStage('hub.completed', 'req_release_preserve', { elapsedMs: 180 });
    logPipelineStage('provider.send.start', 'req_release_preserve', {});
    logPipelineStage('provider.send.completed', 'req_release_preserve', { elapsedMs: 700 });
    logPipelineStage('hub.response.start', 'req_release_preserve', {});
    logPipelineStage('hub.response.completed', 'req_release_preserve', { elapsedMs: 45 });
    logPipelineStage('response.dispatch.start', 'req_release_preserve', { status: 200, stream: false });
    logPipelineStage('response.completed', 'req_release_preserve', { elapsedMs: 15 });

    logRequestComplete('/v1/responses', 'req_release_preserve', 200, {
      status: 'requires_action',
      required_action: { submit_tool_outputs: { tool_calls: [] } }
    }, {
      preserveTimingForUsage: true,
      suppressCompletedLog: true
    });

    logUsageSummary('req_release_preserve', {
      providerKey: 'demo.key1',
      model: 'demo-model',
      finishReason: 'stop',
      latencyMs: 1000,
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    });

    const lines = logSpy.mock.calls.map((call) => String(call[0] ?? ''));
    expect(lines.some((line) => line.includes('completed (status=200'))).toBe(false);
    const rendered = String(lines.at(-1) ?? '');
    const plain = rendered.replace(/\u001b\[[0-9;]*m/g, '');
    expect(plain).not.toContain('request.internal=60ms');
    expect(plain).toContain('hub=180ms');
    expect(plain).toContain('provider.send=700ms');
    expect(plain).not.toContain('hub.response=45ms');
    expect(plain).not.toContain('response=15ms');
  });

  it('includes host.internal in release timing summary when host-side scopes exist', async () => {
    process.env.ROUTECODEX_BUILD_MODE = 'release';
    process.env.ROUTECODEX_USAGE_TIMING = '1';
    delete process.env.ROUTECODEX_STAGE_LOG;
    delete process.env.ROUTECODEX_STAGE_TIMING;
    delete process.env.ROUTECODEX_STAGE_TIMING_SUMMARY;

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const { logPipelineStage } = await import('../../../../../src/server/utils/stage-logger.js');
    const { logUsageSummary } = await import('../../../../../src/server/runtime/http-server/executor/usage-logger.js');

    logPipelineStage('request.snapshot.start', 'req_release_host_internal', {});
    logPipelineStage('request.snapshot.completed', 'req_release_host_internal', { elapsedMs: 120 });
    logPipelineStage('hub.start', 'req_release_host_internal', {});
    logPipelineStage('hub.completed', 'req_release_host_internal', { elapsedMs: 310 });
    logPipelineStage('provider.runtime_resolve.start', 'req_release_host_internal', {});
    logPipelineStage('provider.runtime_resolve.completed', 'req_release_host_internal', { elapsedMs: 40 });
    logPipelineStage('provider.context_resolve.start', 'req_release_host_internal', {});
    logPipelineStage('provider.context_resolve.completed', 'req_release_host_internal', { elapsedMs: 25 });
    logPipelineStage('provider.metadata_attach.start', 'req_release_host_internal', {});
    logPipelineStage('provider.metadata_attach.completed', 'req_release_host_internal', { elapsedMs: 15 });
    logPipelineStage('provider.send.start', 'req_release_host_internal', {});
    logPipelineStage('provider.send.completed', 'req_release_host_internal', { elapsedMs: 700 });
    logPipelineStage('provider.response_normalize.start', 'req_release_host_internal', {});
    logPipelineStage('provider.response_normalize.completed', 'req_release_host_internal', { elapsedMs: 60 });
    logPipelineStage('hub.response.start', 'req_release_host_internal', {});
    logPipelineStage('hub.response.completed', 'req_release_host_internal', { elapsedMs: 90 });
    logPipelineStage('response.dispatch.start', 'req_release_host_internal', { status: 200, stream: false });
    logPipelineStage('response.completed', 'req_release_host_internal', { elapsedMs: 20 });

    logUsageSummary('req_release_host_internal', {
      providerKey: 'demo.key1',
      model: 'demo-model',
      finishReason: 'stop',
      latencyMs: 1500,
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    });

    const rendered = String(logSpy.mock.calls.at(-1)?.[0] ?? '');
    const plain = rendered.replace(/\u001b\[[0-9;]*m/g, '');
    expect(plain).toContain('request.internal=');
    expect(plain).toContain('hub=310ms');
    expect(plain).toContain('provider.send=700ms');
    expect(plain).not.toContain('hub.response=90ms');
    expect(plain).not.toContain('response=20ms');
  });

  it('appends hub stage top summary when provided by pipeline metadata', async () => {
    process.env.ROUTECODEX_BUILD_MODE = 'release';
    process.env.ROUTECODEX_USAGE_TIMING = '1';
    process.env.ROUTECODEX_USAGE_HUB_TOP_N = '2';
    delete process.env.ROUTECODEX_STAGE_LOG;
    delete process.env.ROUTECODEX_STAGE_TIMING;
    delete process.env.ROUTECODEX_STAGE_TIMING_SUMMARY;

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const { logUsageSummary } = await import('../../../../../src/server/runtime/http-server/executor/usage-logger.js');

    logUsageSummary('req_hub_top', {
      providerKey: 'demo.key1',
      model: 'demo-model',
      finishReason: 'stop',
      latencyMs: 1200,
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      hubStageTop: [
        { stage: 'req_inbound.stage2_semantic_map', totalMs: 7600, count: 1 },
        { stage: 'req_outbound.stage1_semantic_map', totalMs: 2100, count: 1 },
        { stage: 'req_process.stage2_route_select', totalMs: 900, count: 1 }
      ]
    });

    const rendered = String(logSpy.mock.calls.at(-1)?.[0] ?? '');
    expect(rendered).toContain('hub.top=');
    expect(rendered).toContain('req_inbound.stage2_semantic_map:7600msx1');
    expect(rendered).toContain('req_outbound.stage1_semantic_map:2100msx1');
    expect(rendered).not.toContain('req_process.stage2_route_select:900msx1');
  });

  it('prints only usage detail timing fields at or above 100ms', async () => {
    process.env.ROUTECODEX_BUILD_MODE = 'release';
    process.env.ROUTECODEX_USAGE_TIMING = '1';
    delete process.env.ROUTECODEX_STAGE_LOG;
    delete process.env.ROUTECODEX_STAGE_TIMING;
    delete process.env.ROUTECODEX_STAGE_TIMING_SUMMARY;

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const { logPipelineStage } = await import('../../../../../src/server/utils/stage-logger.js');
    const { logUsageSummary } = await import('../../../../../src/server/runtime/http-server/executor/usage-logger.js');

    logPipelineStage('request.internal.start', 'req_usage_slow_fields', {});
    logPipelineStage('request.internal.completed', 'req_usage_slow_fields', { elapsedMs: 99 });
    logPipelineStage('hub.start', 'req_usage_slow_fields', {});
    logPipelineStage('hub.completed', 'req_usage_slow_fields', { elapsedMs: 100 });
    logPipelineStage('provider.send.start', 'req_usage_slow_fields', {});
    logPipelineStage('provider.send.completed', 'req_usage_slow_fields', { elapsedMs: 101 });
    logPipelineStage('response.dispatch.start', 'req_usage_slow_fields', { status: 200, stream: false });
    logPipelineStage('response.completed', 'req_usage_slow_fields', { elapsedMs: 1 });

    logUsageSummary('req_usage_slow_fields', {
      providerKey: 'demo.key1',
      model: 'demo-model',
      finishReason: 'stop',
      latencyMs: 1200,
      trafficWaitMs: 99,
      clientInjectWaitMs: 100,
      sseDecodeMs: 1,
      codecDecodeMs: 101,
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      hubStageTop: [
        { stage: 'fast.stage', totalMs: 99, count: 1 },
        { stage: 'slow.stage', totalMs: 100, count: 1 }
      ]
    });

    const rendered = String(logSpy.mock.calls.at(-1)?.[0] ?? '');
    const plain = rendered.replace(/\u001b\[[0-9;]*m/g, '');
    expect(plain).not.toContain('request.internal=99ms');
    expect(plain).toContain('hub=100ms');
    expect(plain).toContain('provider.send=101ms');
    expect(plain).not.toContain('response=1ms');
    expect(plain).not.toContain('wait.traffic=99ms');
    expect(plain).toContain('wait.inject=100ms');
    expect(plain).not.toContain('decode.sse=1ms');
    expect(plain).toContain('decode.codec=101ms');
    expect(plain).not.toContain('fast.stage:99msx1');
    expect(plain).toContain('slow.stage:100msx1');
  });

  it('rolls up non-stop usage logs into 1-minute summary', async () => {
    process.env.ROUTECODEX_BUILD_MODE = 'release';
    process.env.ROUTECODEX_USAGE_TIMING = '1';
    process.env.ROUTECODEX_LOG_ROLLUP = '1';
    process.env.ROUTECODEX_LOG_ROLLUP_REALTIME = '0';

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const { logUsageSummary } = await import('../../../../../src/server/runtime/http-server/executor/usage-logger.js');
    const { flushLogRollup } = await import('../../../../../src/server/runtime/http-server/executor/log-rollup.js');

    logUsageSummary('req_rollup_1', {
      providerKey: 'qwen.1',
      model: 'qwen3.6-plus',
      routeName: 'default',
      poolId: 'tools-primary',
      finishReason: 'length',
      latencyMs: 1000,
      externalLatencyMs: 600,
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    });
    logUsageSummary('req_rollup_2', {
      providerKey: 'qwen.1',
      model: 'qwen3.6-plus',
      routeName: 'default',
      poolId: 'tools-primary',
      finishReason: 'length',
      latencyMs: 1200,
      externalLatencyMs: 700,
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    });

    flushLogRollup('manual');
    const lines = logSpy.mock.calls.map((call) => String(call[0] ?? ''));
    expect(lines.some((line) => line.includes('[usage] req='))).toBe(true);
    expect(lines.some((line) => line.includes('req=req_rollup_1'))).toBe(true);
    expect(lines.some((line) => line.includes('req=req_rollup_2'))).toBe(true);
    expect(lines.some((line) => line.includes('[usage][1m]'))).toBe(true);
    expect(lines.some((line) => line.includes('default/tools-primary'))).toBe(true);
    expect(lines.some((line) => line.includes('provider=qwen.1.qwen3.6-plus'))).toBe(true);
    expect(lines.some((line) => line.includes('calls=2'))).toBe(true);
    expect(lines.some((line) => line.includes('avg.total=1100ms'))).toBe(true);
    expect(lines.some((line) => line.includes('avg.internal=450ms'))).toBe(true);
    expect(lines.some((line) => line.includes('avg.external=650ms'))).toBe(true);
  });

  it('treats hub codec stream drain as decode wait in hub decode breakdown', async () => {
    const { readHubDecodeBreakdown } = await import('../../../../../src/server/runtime/http-server/executor/retry-payload-snapshot.js');

    const decode = readHubDecodeBreakdown([
      { stage: 'resp_inbound.stage1_codec_decode', totalMs: 33734, count: 1 }
    ]);

    expect(decode).toEqual({
      sseDecodeMs: 33734,
      codecDecodeMs: 33734
    });
  });
});
