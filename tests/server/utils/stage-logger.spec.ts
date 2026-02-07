import { jest } from '@jest/globals';

describe('stage logger verbosity filtering', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
    jest.restoreAllMocks();
  });

  async function importStageLogger() {
    return import('../../../src/server/utils/stage-logger.js');
  }

  it('suppresses provider info logs in development by default', async () => {
    process.env.NODE_ENV = 'development';
    delete process.env.ROUTECODEX_STAGE_LOG;
    delete process.env.ROUTECODEX_STAGE_LOG_VERBOSE;

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const { logPipelineStage } = await importStageLogger();

    logPipelineStage('provider.send.start', 'req_provider', {
      providerLabel: 'iflow.key1.kimi-k2.5',
      model: 'kimi-k2.5'
    });

    expect(logSpy).not.toHaveBeenCalled();
  });

  it('keeps request logs and only prints request id by default', async () => {
    process.env.NODE_ENV = 'development';
    delete process.env.ROUTECODEX_STAGE_LOG;
    delete process.env.ROUTECODEX_STAGE_LOG_VERBOSE;

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const { logPipelineStage } = await importStageLogger();

    logPipelineStage('request.received', 'req_request', { endpoint: '/v1/responses', stream: true });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const rendered = String(logSpy.mock.calls[0]?.[0] ?? '');
    expect(rendered).toContain('[request][req_request] received');
    expect(rendered).not.toContain('endpoint');
    expect(rendered).not.toContain('stream');
  });

  it('suppresses response sse logs by default', async () => {
    process.env.NODE_ENV = 'development';
    delete process.env.ROUTECODEX_STAGE_LOG;
    delete process.env.ROUTECODEX_STAGE_LOG_VERBOSE;

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const { logPipelineStage } = await importStageLogger();

    logPipelineStage('response.sse.stream.start', 'req_sse', { status: 200 });

    expect(logSpy).not.toHaveBeenCalled();
  });

  it('always prints errors with details', async () => {
    process.env.NODE_ENV = 'development';
    delete process.env.ROUTECODEX_STAGE_LOG;
    delete process.env.ROUTECODEX_STAGE_LOG_VERBOSE;

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const { logPipelineStage } = await importStageLogger();

    logPipelineStage('provider.send.error', 'req_error', { message: 'boom' });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const rendered = String(logSpy.mock.calls[0]?.[0] ?? '');
    expect(rendered).toContain('[provider.send][req_error] error');
    expect(rendered).toContain('boom');
  });

  it('prints provider info logs when verbose override is enabled', async () => {
    process.env.NODE_ENV = 'development';
    process.env.ROUTECODEX_STAGE_LOG_VERBOSE = '1';

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const { logPipelineStage } = await importStageLogger();

    logPipelineStage('provider.send.start', 'req_provider_verbose', {
      providerLabel: 'crs.key1.gpt-5.2-codex',
      model: 'gpt-5.2-codex'
    });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const rendered = String(logSpy.mock.calls[0]?.[0] ?? '');
    expect(rendered).toContain('[provider.send][req_provider_verbose] start');
    expect(rendered).toContain('model');
  });
});
