import { jest } from '@jest/globals';

type BuildMode = 'dev' | 'release';

describe('PipelineDebugLogger provider noise filtering in dev', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
    jest.resetModules();
  });

  async function importLoggerWithMode(mode: BuildMode) {
    jest.unstable_mockModule('../../../../src/build-info.js', () => ({
      buildInfo: {
        mode,
        version: 'test',
        buildTime: '2026-02-07T00:00:00.000Z'
      }
    }));
    const mod = await import('../../../../src/modules/pipeline/utils/debug-logger.js');
    return mod.PipelineDebugLogger;
  }

  it('suppresses provider request start/success by default in dev', async () => {
    delete process.env.ROUTECODEX_PROVIDER_LOG_VERBOSE;
    delete process.env.ROUTECODEX_PIPELINE_LOG_VERBOSE;

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const PipelineDebugLogger = await importLoggerWithMode('dev');
    const logger = new PipelineDebugLogger({}, { enableConsoleLogging: true });

    logger.logProviderRequest('provider:crs.key1', 'request-start', { requestId: 'req_1' });
    logger.logProviderRequest('provider:crs.key1', 'request-success', { responseTime: 1000 });

    expect(logSpy).not.toHaveBeenCalled();
  });

  it('suppresses provider errors in dev when provider verbose logging is disabled', async () => {
    delete process.env.ROUTECODEX_PROVIDER_LOG_VERBOSE;
    delete process.env.ROUTECODEX_PIPELINE_LOG_VERBOSE;

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const PipelineDebugLogger = await importLoggerWithMode('dev');
    const logger = new PipelineDebugLogger({}, { enableConsoleLogging: true });

    logger.logProviderRequest('provider:crs.key1', 'request-error', { message: 'boom' });

    expect(logSpy).not.toHaveBeenCalled();
  });

  it('suppresses provider module info logs by default in dev', async () => {
    delete process.env.ROUTECODEX_PROVIDER_LOG_VERBOSE;
    delete process.env.ROUTECODEX_PIPELINE_LOG_VERBOSE;

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const PipelineDebugLogger = await importLoggerWithMode('dev');
    const logger = new PipelineDebugLogger({}, { enableConsoleLogging: true });

    logger.logModule('provider-12345', 'responses-provider-stream-flag', { outboundStream: true });

    expect(logSpy).not.toHaveBeenCalled();
  });

  it('restores provider details when verbose env is enabled', async () => {
    process.env.ROUTECODEX_PROVIDER_LOG_VERBOSE = '1';

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const PipelineDebugLogger = await importLoggerWithMode('dev');
    const logger = new PipelineDebugLogger({}, { enableConsoleLogging: true });

    logger.logProviderRequest('provider:crs.key1', 'request-start', { requestId: 'req_2' });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const rendered = String(logSpy.mock.calls[0]?.[0] ?? '');
    expect(rendered).toContain('request-start');
    expect(rendered).toContain('req_2');
  });
});
