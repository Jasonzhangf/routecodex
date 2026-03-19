import { jest } from '@jest/globals';

describe('stage logger release summary mode', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
    jest.restoreAllMocks();
  });

  it('prints hub/provider/response summaries in release by default', async () => {
    process.env.ROUTECODEX_BUILD_MODE = 'release';
    delete process.env.ROUTECODEX_STAGE_LOG;
    delete process.env.ROUTECODEX_STAGE_LOG_VERBOSE;
    delete process.env.ROUTECODEX_STAGE_TIMING;
    delete process.env.ROUTECODEX_STAGE_TIMING_SUMMARY;

    const timestamps = [1000, 1000, 1000, 1300, 1300, 1300, 1400, 1440];
    jest.spyOn(Date, 'now').mockImplementation(() => timestamps.shift() ?? 1900);

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const { logPipelineStage } = await import('../../../src/server/utils/stage-logger.js');

    logPipelineStage('request.received', 'req_release', { endpoint: '/v1/responses' });
    logPipelineStage('hub.start', 'req_release', {});
    logPipelineStage('hub.completed', 'req_release', { route: 'thinking', elapsedMs: 300 });
    logPipelineStage('provider.send.start', 'req_release', {});
    logPipelineStage('provider.send.completed', 'req_release', { status: 200, elapsedMs: 600 });
    logPipelineStage('hub.response.start', 'req_release', {});
    logPipelineStage('hub.response.completed', 'req_release', {
      status: 200,
      elapsedMs: 90,
      finishReason: 'tool_calls'
    });
    logPipelineStage('response.dispatch.start', 'req_release', { status: 200, stream: false });
    logPipelineStage('response.completed', 'req_release', {
      status: 200,
      elapsedMs: 40,
      finishReason: 'tool_calls'
    });

    expect(logSpy).toHaveBeenCalledTimes(4);
    expect(String(logSpy.mock.calls[0]?.[0] ?? '')).toContain('[hub][req_release] completed total=300ms');
    expect(String(logSpy.mock.calls[1]?.[0] ?? '')).toContain('[provider.send][req_release] completed total=600ms');
    expect(String(logSpy.mock.calls[2]?.[0] ?? '')).toContain('[hub.response][req_release] completed total=90ms');
    expect(String(logSpy.mock.calls[2]?.[0] ?? '')).toContain('finish_reason=tool_calls');
    expect(String(logSpy.mock.calls[2]?.[0] ?? '')).toContain('\x1b[97mfinish_reason=tool_calls\x1b[0m');
    expect(String(logSpy.mock.calls[3]?.[0] ?? '')).toContain('[response][req_release] completed total=40ms');
    expect(String(logSpy.mock.calls[3]?.[0] ?? '')).toContain('finish_reason=tool_calls');
    expect(String(logSpy.mock.calls[3]?.[0] ?? '')).toContain('\x1b[97mfinish_reason=tool_calls\x1b[0m');
  });

  it('moves tracked scope timings when request id is rebound', async () => {
    process.env.ROUTECODEX_BUILD_MODE = 'release';
    delete process.env.ROUTECODEX_STAGE_LOG;
    delete process.env.ROUTECODEX_STAGE_LOG_VERBOSE;
    delete process.env.ROUTECODEX_STAGE_TIMING;
    delete process.env.ROUTECODEX_STAGE_TIMING_SUMMARY;

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const { logPipelineStage, rebindRequestTimingTimeline, formatRequestTimingSummary } =
      await import('../../../src/server/utils/stage-logger.js');

    logPipelineStage('hub.start', 'req_base', {});
    logPipelineStage('hub.completed', 'req_base', { elapsedMs: 300 });
    rebindRequestTimingTimeline('req_base', 'req_provider');
    logPipelineStage('provider.send.start', 'req_provider', {});
    logPipelineStage('provider.send.completed', 'req_provider', { elapsedMs: 600 });
    logPipelineStage('response.dispatch.start', 'req_provider', { status: 200, stream: false });
    logPipelineStage('response.completed', 'req_provider', { elapsedMs: 25 });

    const summary = formatRequestTimingSummary('req_provider', { latencyMs: 1000 });
    expect(summary).toContain('hub=300ms');
    expect(summary).toContain('provider.send=600ms');
    expect(summary).toContain('response=25ms');
    expect(summary).toContain('request.internal=75ms');
    expect(logSpy).toHaveBeenCalled();
  });

  it('includes tracked host-side request scopes in release timing summary', async () => {
    process.env.ROUTECODEX_BUILD_MODE = 'release';
    delete process.env.ROUTECODEX_STAGE_LOG;
    delete process.env.ROUTECODEX_STAGE_LOG_VERBOSE;
    delete process.env.ROUTECODEX_STAGE_TIMING;
    delete process.env.ROUTECODEX_STAGE_TIMING_SUMMARY;

    const { logPipelineStage, formatRequestTimingSummary } =
      await import('../../../src/server/utils/stage-logger.js');

    logPipelineStage('request.snapshot.start', 'req_host_breakdown', {});
    logPipelineStage('request.snapshot.completed', 'req_host_breakdown', { elapsedMs: 120 });
    logPipelineStage('hub.start', 'req_host_breakdown', {});
    logPipelineStage('hub.completed', 'req_host_breakdown', { elapsedMs: 310 });
    logPipelineStage('provider.runtime_resolve.start', 'req_host_breakdown', {});
    logPipelineStage('provider.runtime_resolve.completed', 'req_host_breakdown', { elapsedMs: 40 });
    logPipelineStage('provider.context_resolve.start', 'req_host_breakdown', {});
    logPipelineStage('provider.context_resolve.completed', 'req_host_breakdown', { elapsedMs: 25 });
    logPipelineStage('provider.metadata_attach.start', 'req_host_breakdown', {});
    logPipelineStage('provider.metadata_attach.completed', 'req_host_breakdown', { elapsedMs: 15 });
    logPipelineStage('provider.send.start', 'req_host_breakdown', {});
    logPipelineStage('provider.send.completed', 'req_host_breakdown', { elapsedMs: 700 });
    logPipelineStage('provider.response_normalize.start', 'req_host_breakdown', {});
    logPipelineStage('provider.response_normalize.completed', 'req_host_breakdown', { elapsedMs: 60 });
    logPipelineStage('hub.response.start', 'req_host_breakdown', {});
    logPipelineStage('hub.response.completed', 'req_host_breakdown', { elapsedMs: 90 });
    logPipelineStage('response.dispatch.start', 'req_host_breakdown', {});
    logPipelineStage('response.completed', 'req_host_breakdown', { elapsedMs: 20 });

    const summary = formatRequestTimingSummary('req_host_breakdown', { latencyMs: 1500 });
    expect(summary).toContain('request.snapshot=120ms');
    expect(summary).toContain('hub=310ms');
    expect(summary).toContain('provider.runtime_resolve=40ms');
    expect(summary).toContain('provider.context_resolve=25ms');
    expect(summary).toContain('provider.metadata_attach=15ms');
    expect(summary).toContain('provider.send=700ms');
    expect(summary).toContain('provider.response_normalize=60ms');
    expect(summary).toContain('hub.response=90ms');
    expect(summary).toContain('response=20ms');
    expect(summary).toContain('host.internal=260ms');
    expect(summary).toContain('request.internal=120ms');
  });
});
