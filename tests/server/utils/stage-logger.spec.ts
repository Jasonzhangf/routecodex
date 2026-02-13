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

  it('suppresses provider stage status in development by default', async () => {
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

  it('suppresses request logs by default', async () => {
    process.env.NODE_ENV = 'development';
    delete process.env.ROUTECODEX_STAGE_LOG;
    delete process.env.ROUTECODEX_STAGE_LOG_VERBOSE;

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const { logPipelineStage } = await importStageLogger();

    logPipelineStage('request.received', 'req_request', { endpoint: '/v1/responses', stream: true });

    expect(logSpy).not.toHaveBeenCalled();
  });

  it('suppresses provider completion logs by default', async () => {
    process.env.NODE_ENV = 'development';
    delete process.env.ROUTECODEX_STAGE_LOG;
    delete process.env.ROUTECODEX_STAGE_LOG_VERBOSE;

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const { logPipelineStage } = await importStageLogger();

    logPipelineStage('provider.send.completed', 'req_completed', { status: 200 });

    expect(logSpy).not.toHaveBeenCalled();
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

  it('suppresses provider send errors by default to avoid duplicate HTTP error logs', async () => {
    process.env.NODE_ENV = 'development';
    delete process.env.ROUTECODEX_STAGE_LOG;
    delete process.env.ROUTECODEX_STAGE_LOG_VERBOSE;

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const { logPipelineStage } = await importStageLogger();

    logPipelineStage('provider.send.error', 'req_error', { message: 'boom' });

    expect(logSpy).not.toHaveBeenCalled();
  });

  it('prints non-provider errors with details when stage logging is enabled', async () => {
    process.env.NODE_ENV = 'development';
    delete process.env.ROUTECODEX_STAGE_LOG;
    delete process.env.ROUTECODEX_STAGE_LOG_VERBOSE;

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const { logPipelineStage } = await importStageLogger();

    logPipelineStage('response.sse.stream.error', 'req_error', { message: 'boom' });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const rendered = String(logSpy.mock.calls[0]?.[0] ?? '');
    expect(rendered).toContain('[response.sse.stream][req_error] error');
    expect(rendered).toContain('boom');
  });

  it('prints provider info logs with details when verbose override is enabled', async () => {
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
    expect(rendered).toContain('crs.key1.gpt-5.2-codex');
  });

  it('still suppresses provider.send.error when verbose is enabled', async () => {
    process.env.NODE_ENV = 'development';
    process.env.ROUTECODEX_STAGE_LOG_VERBOSE = '1';

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const { logPipelineStage } = await importStageLogger();

    logPipelineStage('provider.send.error', 'req_provider_verbose_err', { message: 'boom' });

    expect(logSpy).not.toHaveBeenCalled();
  });

  it('keeps hub completion logs suppressed in dev build mode without verbose', async () => {
    process.env.NODE_ENV = 'production';
    process.env.ROUTECODEX_BUILD_MODE = 'dev';
    delete process.env.ROUTECODEX_STAGE_LOG;
    delete process.env.ROUTECODEX_STAGE_LOG_VERBOSE;

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const { logPipelineStage } = await importStageLogger();

    logPipelineStage('hub.completed', 'req_build_mode', { route: 'thinking' });

    expect(logSpy).not.toHaveBeenCalled();
  });
});
