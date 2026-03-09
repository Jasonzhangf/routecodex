import { jest } from '@jest/globals';

describe('http server runtime stage timing defaults', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
    jest.restoreAllMocks();
  });

  it('keeps dev stage timing and detail disabled by default', async () => {
    process.env.ROUTECODEX_BUILD_MODE = 'dev';
    delete process.env.ROUTECODEX_STAGE_TIMING;
    delete process.env.ROUTECODEX_HUB_STAGE_TIMING_DETAIL;

    const { applyDefaultStageTimingMode } = await import('../../../../src/server/runtime/http-server/stage-timing-defaults.js');
    applyDefaultStageTimingMode();

    expect(process.env.ROUTECODEX_STAGE_TIMING).toBeUndefined();
    expect(process.env.ROUTECODEX_HUB_STAGE_TIMING_DETAIL).toBe('0');
  });

  it('keeps release hub detail disabled by default', async () => {
    process.env.ROUTECODEX_BUILD_MODE = 'release';
    delete process.env.ROUTECODEX_STAGE_TIMING;
    delete process.env.ROUTECODEX_HUB_STAGE_TIMING_DETAIL;

    const { applyDefaultStageTimingMode } = await import('../../../../src/server/runtime/http-server/stage-timing-defaults.js');
    applyDefaultStageTimingMode();

    expect(process.env.ROUTECODEX_STAGE_TIMING).toBeUndefined();
    expect(process.env.ROUTECODEX_HUB_STAGE_TIMING_DETAIL).toBe('0');
  });
});
