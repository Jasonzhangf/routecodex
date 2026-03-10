import {
  clearHubStageTiming,
  logHubStageTiming,
} from '../../src/conversion/hub/pipeline/hub-stage-timing.js';

describe('hub stage timing reset', () => {
  const envKeys = [
    'ROUTECODEX_STAGE_TIMING',
    'RCC_STAGE_TIMING',
    'ROUTECODEX_HUB_STAGE_TIMING',
    'RCC_HUB_STAGE_TIMING'
  ] as const;
  const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

  beforeEach(() => {
    jest.restoreAllMocks();
    process.env.ROUTECODEX_STAGE_TIMING = '1';
  });

  afterEach(() => {
    clearHubStageTiming('req-reset');
    for (const key of envKeys) {
      const value = previousEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  test('clears accumulated timeline for reused request ids', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(Date, 'now')
      .mockReturnValueOnce(1000)
      .mockReturnValueOnce(1100)
      .mockReturnValueOnce(2000)
      .mockReturnValueOnce(2100);

    logHubStageTiming('req-reset', 'req_process.stage2_route_select', 'start');
    logHubStageTiming('req-reset', 'req_process.stage2_route_select', 'completed', {
      elapsedMs: 100,
    });
    clearHubStageTiming('req-reset');
    logHubStageTiming('req-reset', 'req_process.stage2_route_select', 'start');
    logHubStageTiming('req-reset', 'req_process.stage2_route_select', 'completed', {
      elapsedMs: 100,
    });

    expect(logSpy).toHaveBeenCalledTimes(2);
    expect(logSpy.mock.calls[0]?.[0]).toContain('t+100ms');
    expect(logSpy.mock.calls[1]?.[0]).toContain('t+100ms');
  });
});
