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
    logPipelineStage('hub.response.completed', 'req_release', { status: 200, elapsedMs: 90 });
    logPipelineStage('response.dispatch.start', 'req_release', { status: 200, stream: false });
    logPipelineStage('response.completed', 'req_release', { status: 200, elapsedMs: 40 });

    expect(logSpy).toHaveBeenCalledTimes(4);
    expect(String(logSpy.mock.calls[0]?.[0] ?? '')).toContain('[hub][req_release] completed total=300ms');
    expect(String(logSpy.mock.calls[1]?.[0] ?? '')).toContain('[provider.send][req_release] completed total=600ms');
    expect(String(logSpy.mock.calls[2]?.[0] ?? '')).toContain('[hub.response][req_release] completed total=90ms');
    expect(String(logSpy.mock.calls[3]?.[0] ?? '')).toContain('[response][req_release] completed total=40ms');
  });
});
