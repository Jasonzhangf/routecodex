import { jest } from '@jest/globals';

type BuildMode = 'dev' | 'release';

describe('PipelineDebugLogger release console behavior', () => {
  const originalVerboseEnv = process.env.ROUTECODEX_PIPELINE_LOG_VERBOSE;

  afterEach(() => {
    jest.restoreAllMocks();
    jest.resetModules();
    if (originalVerboseEnv === undefined) {
      delete process.env.ROUTECODEX_PIPELINE_LOG_VERBOSE;
    } else {
      process.env.ROUTECODEX_PIPELINE_LOG_VERBOSE = originalVerboseEnv;
    }
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

  it('prints pipeline/provider console logs in release by default', async () => {
    delete process.env.ROUTECODEX_PIPELINE_LOG_VERBOSE;
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const PipelineDebugLogger = await importLoggerWithMode('release');
    const logger = new PipelineDebugLogger({}, { enableConsoleLogging: true });

    logger.logVirtualRouterHit('default', 'provider.key1', 'model-a');
    logger.logProviderRequest('provider:key1', 'request-start', { id: 'req-1' });
    logger.logModule('provider.send', 'completed', { status: 200 });

    expect(logSpy).toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('passes session id through virtual-router-hit logger output', async () => {
    delete process.env.ROUTECODEX_PIPELINE_LOG_VERBOSE;
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    const PipelineDebugLogger = await importLoggerWithMode('release');
    const logger = new PipelineDebugLogger({}, { enableConsoleLogging: true });

    logger.logVirtualRouterHit('tools/tools-primary', 'provider.key1', 'model-a', 'session-123');

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[session-123]'));
  });

  it('does not prepend undefined text when virtual-router-hit has no session id', async () => {
    delete process.env.ROUTECODEX_PIPELINE_LOG_VERBOSE;
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    const PipelineDebugLogger = await importLoggerWithMode('release');
    const logger = new PipelineDebugLogger({}, { enableConsoleLogging: true });

    logger.logVirtualRouterHit('coding/coding-primary', 'provider.key1', 'model-a');

    expect(String(logSpy.mock.calls[0]?.[0] ?? '')).not.toContain('undefinedcoding');
  });

  it('allows release pipeline/provider console logs to be disabled via env override', async () => {
    process.env.ROUTECODEX_PIPELINE_LOG_VERBOSE = '0';
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    const PipelineDebugLogger = await importLoggerWithMode('release');
    const logger = new PipelineDebugLogger({}, { enableConsoleLogging: true });

    logger.logVirtualRouterHit('default', 'provider.key1', 'model-a');

    expect(logSpy).not.toHaveBeenCalled();
  });
});
