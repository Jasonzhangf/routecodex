import { jest } from '@jest/globals';

describe('stage logger pruning', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-04-15T10:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
    process.env = { ...originalEnv };
    jest.resetModules();
    jest.restoreAllMocks();
  });

  it('drops stale scope timings once the owning request timeline expires', async () => {
    process.env.ROUTECODEX_BUILD_MODE = 'release';
    process.env.ROUTECODEX_USAGE_TIMING = '1';
    process.env.ROUTECODEX_STAGE_TIMELINE_TTL_MS = '1000';
    process.env.ROUTECODEX_STAGE_TIMELINE_MAX_ENTRIES = '10';

    jest.spyOn(console, 'log').mockImplementation(() => {});
    const { logPipelineStage, formatRequestTimingSummary } =
      await import('../../../src/server/utils/stage-logger.js');

    logPipelineStage('hub.start', 'req-stale', {});
    logPipelineStage('hub.completed', 'req-stale', { elapsedMs: 120 });

    expect(formatRequestTimingSummary('req-stale', { latencyMs: 200 })).toContain('hub=120ms');

    jest.advanceTimersByTime(1500);

    expect(formatRequestTimingSummary('req-stale', { latencyMs: 200 })).toBe('');
  });

  it('evicts oldest scope timings when request timeline budget is exceeded', async () => {
    process.env.ROUTECODEX_BUILD_MODE = 'release';
    process.env.ROUTECODEX_USAGE_TIMING = '1';
    process.env.ROUTECODEX_STAGE_TIMELINE_TTL_MS = '600000';
    process.env.ROUTECODEX_STAGE_TIMELINE_MAX_ENTRIES = '2';

    jest.spyOn(console, 'log').mockImplementation(() => {});
    const { logPipelineStage, formatRequestTimingSummary } =
      await import('../../../src/server/utils/stage-logger.js');

    logPipelineStage('hub.start', 'req-1', {});
    logPipelineStage('hub.completed', 'req-1', { elapsedMs: 100 });
    jest.advanceTimersByTime(10);

    logPipelineStage('hub.start', 'req-2', {});
    logPipelineStage('hub.completed', 'req-2', { elapsedMs: 110 });
    jest.advanceTimersByTime(10);

    logPipelineStage('hub.start', 'req-3', {});
    logPipelineStage('hub.completed', 'req-3', { elapsedMs: 120 });

    expect(formatRequestTimingSummary('req-1', { latencyMs: 200 })).toBe('');
    expect(formatRequestTimingSummary('req-2', { latencyMs: 200 })).toContain('hub=110ms');
    expect(formatRequestTimingSummary('req-3', { latencyMs: 200 })).toContain('hub=120ms');
  });
});
