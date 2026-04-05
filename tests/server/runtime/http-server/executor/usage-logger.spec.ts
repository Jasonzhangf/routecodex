import { jest } from '@jest/globals';

describe('usage logger timing summary', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
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
      latencyMs: 120,
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    });

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[usage] request req_usage_timing'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('t+120ms Δ120ms'));
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
      latencyMs: 1100,
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    });

    const rendered = String(logSpy.mock.calls.at(-1)?.[0] ?? '');
    expect(rendered).toContain('request.internal=100ms');
    expect(rendered).toContain('hub=140ms');
    expect(rendered).toContain('provider.send=800ms');
    expect(rendered).toContain('hub.response=40ms');
    expect(rendered).toContain('response=20ms');
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
      latencyMs: 720,
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      hubStageTop: [
        { stage: 'req_inbound.stage2_semantic_map', totalMs: 700, count: 1 }
      ]
    });

    const rendered = String(logSpy.mock.calls.at(-1)?.[0] ?? '');
    expect(rendered).toContain('[usage] request req_release_no_timing');
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
      latencyMs: 1025,
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    });

    const rendered = String(logSpy.mock.calls.at(-1)?.[0] ?? '');
    expect(rendered).toContain('[usage] request req_release_usage');
    expect(rendered).toContain('latency=1025.0ms');
    expect(rendered).toContain('timing={');
    expect(rendered).toContain('request.internal=0ms');
    expect(rendered).toContain('hub=');
    expect(rendered).toContain('provider.send=');
    expect(rendered).toContain('hub.response=');
    expect(rendered).toContain('response=');
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
      latencyMs: 1000,
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    });

    const rendered = String(logSpy.mock.calls.at(-1)?.[0] ?? '');
    expect(rendered).toContain('request.internal=100ms');
    expect(rendered).toContain('hub=150ms');
    expect(rendered).toContain('provider.send=700ms');
    expect(rendered).toContain('hub.response=40ms');
    expect(rendered).toContain('response=10ms');
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
      latencyMs: 1000,
      timingRequestIds: ['req_base', 'req_final'],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    });

    const rendered = String(logSpy.mock.calls.at(-1)?.[0] ?? '');
    expect(rendered).toContain('request.internal=145ms');
    expect(rendered).toContain('hub=120ms');
    expect(rendered).toContain('provider.send=700ms');
    expect(rendered).toContain('hub.response=30ms');
    expect(rendered).toContain('response=5ms');
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
      preserveTimingForUsage: true
    });

    logUsageSummary('req_release_preserve', {
      providerKey: 'demo.key1',
      model: 'demo-model',
      latencyMs: 1000,
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    });

    const rendered = String(logSpy.mock.calls.at(-1)?.[0] ?? '');
    expect(rendered).toContain('request.internal=60ms');
    expect(rendered).toContain('hub=180ms');
    expect(rendered).toContain('provider.send=700ms');
    expect(rendered).toContain('hub.response=45ms');
    expect(rendered).toContain('response=15ms');
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
      latencyMs: 1500,
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    });

    const rendered = String(logSpy.mock.calls.at(-1)?.[0] ?? '');
    expect(rendered).toContain('request.internal=120ms');
    expect(rendered).toContain('host.internal=260ms');
    expect(rendered).toContain('request.snapshot=120ms');
    expect(rendered).toContain('provider.runtime_resolve=40ms');
    expect(rendered).toContain('provider.context_resolve=25ms');
    expect(rendered).toContain('provider.metadata_attach=15ms');
    expect(rendered).toContain('provider.response_normalize=60ms');
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
});
