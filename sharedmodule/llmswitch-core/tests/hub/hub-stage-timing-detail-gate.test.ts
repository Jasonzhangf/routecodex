import { logHubStageTiming } from '../../src/conversion/hub/pipeline/hub-stage-timing.js';

describe('hub stage timing detail gate', () => {
  const envKeys = [
    'ROUTECODEX_STAGE_TIMING',
    'RCC_STAGE_TIMING',
    'ROUTECODEX_HUB_STAGE_TIMING',
    'RCC_HUB_STAGE_TIMING',
    'ROUTECODEX_STAGE_TIMING_DETAIL',
    'RCC_STAGE_TIMING_DETAIL',
    'ROUTECODEX_HUB_STAGE_TIMING_DETAIL',
    'RCC_HUB_STAGE_TIMING_DETAIL'
  ] as const;
  const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

  beforeEach(() => {
    jest.restoreAllMocks();
    for (const key of envKeys) {
      delete process.env[key];
    }
  });

  afterAll(() => {
    for (const key of envKeys) {
      const value = previousEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  test('does not log by default in release-style unset env', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    logHubStageTiming('req-default-off', 'req_inbound.responses.capture_context', 'completed', {
      elapsedMs: 100,
      forceLog: true
    });

    expect(logSpy).not.toHaveBeenCalled();
  });

  test('does not honor forceLog unless detail switch is enabled', () => {
    process.env.ROUTECODEX_STAGE_TIMING = '1';
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    logHubStageTiming('req-force-gated', 'req_inbound.responses.capture_context', 'completed', {
      elapsedMs: 1,
      forceLog: true
    });

    expect(logSpy).not.toHaveBeenCalled();
  });

  test('logs forced detail when stage timing and detail switch are both enabled', () => {
    process.env.ROUTECODEX_STAGE_TIMING = '1';
    process.env.ROUTECODEX_HUB_STAGE_TIMING_DETAIL = '1';
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    logHubStageTiming('req-force-on', 'req_inbound.responses.capture_context', 'completed', {
      elapsedMs: 1,
      forceLog: true
    });

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]?.[0]).toContain('[hub.detail][req-force-on]');
  });

  test('logs slow stage when stage timing is enabled without detail switch', () => {
    process.env.ROUTECODEX_STAGE_TIMING = '1';
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(Date, 'now')
      .mockReturnValueOnce(1000)
      .mockReturnValueOnce(1100);

    logHubStageTiming('req-threshold-on', 'req_process.stage1_tool_governance', 'start');
    logHubStageTiming('req-threshold-on', 'req_process.stage1_tool_governance', 'completed', {
      elapsedMs: 100
    });

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]?.[0]).toContain('[hub.detail][req-threshold-on]');
  });
});
