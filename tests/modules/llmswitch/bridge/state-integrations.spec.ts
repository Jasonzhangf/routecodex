import { describe, expect, it, jest } from '@jest/globals';

describe('llmswitch bridge state-integrations', () => {
  it('fails fast when sticky session load throws', async () => {
    jest.resetModules();

    jest.unstable_mockModule(
      '../../../../src/modules/llmswitch/bridge/module-loader.js',
      () => ({
        importCoreDist: jest.fn(),
        requireCoreDist: jest.fn((subpath: string) => {
          if (subpath === 'router/virtual-router/sticky-session-store') {
            return {
              loadRoutingInstructionStateSync: () => {
                throw new Error('sticky boom');
              },
              saveRoutingInstructionStateAsync: () => undefined,
              saveRoutingInstructionStateSync: () => undefined
            };
          }
          throw new Error(`unexpected:${subpath}`);
        })
      })
    );

    const mod = await import('../../../../src/modules/llmswitch/bridge/state-integrations.js');

    expect(() => mod.loadRoutingInstructionStateSync('session:test')).toThrow(
      'sticky_session_store.load_state.invoke failed: Error: sticky boom'
    );
  });

  it('fails fast when reasoning stop sync api is unavailable', async () => {
    jest.resetModules();

    jest.unstable_mockModule(
      '../../../../src/modules/llmswitch/bridge/module-loader.js',
      () => ({
        importCoreDist: jest.fn(),
        requireCoreDist: jest.fn((subpath: string) => {
          if (subpath === 'servertool/handlers/reasoning-stop-state') {
            return {};
          }
          throw new Error(`unexpected:${subpath}`);
        })
      })
    );

    const mod = await import('../../../../src/modules/llmswitch/bridge/state-integrations.js');

    expect(() => mod.syncReasoningStopModeFromRequest({}, 'off')).toThrow(
      'reasoning_stop_state.sync_mode.api_unavailable failed: "syncReasoningStopModeFromRequest not available"'
    );
  });

  it('fails fast when session identifier extraction api is unavailable', async () => {
    jest.resetModules();

    jest.unstable_mockModule(
      '../../../../src/modules/llmswitch/bridge/module-loader.js',
      () => ({
        importCoreDist: jest.fn(),
        requireCoreDist: jest.fn((subpath: string) => {
          if (subpath === 'conversion/hub/pipeline/session-identifiers') {
            return {};
          }
          throw new Error(`unexpected:${subpath}`);
        })
      })
    );

    const mod = await import('../../../../src/modules/llmswitch/bridge/state-integrations.js');

    expect(() => mod.extractSessionIdentifiersFromMetadata({})).toThrow(
      'session_identifiers.extract.api_unavailable failed: "extractSessionIdentifiersFromMetadata not available"'
    );
  });

  it('fails fast and does not fallback to legacy clock task-store modules when primary loader fails', async () => {
    jest.resetModules();

    const importCoreDist = jest.fn(async (subpath: string) => {
      throw new Error(`missing:${subpath}`);
    });

    jest.unstable_mockModule(
      '../../../../src/modules/llmswitch/bridge/module-loader.js',
      () => ({
        importCoreDist,
        requireCoreDist: jest.fn()
      })
    );

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const mod = await import('../../../../src/modules/llmswitch/bridge/state-integrations.js');

    await expect(mod.resolveClockConfigSnapshot(undefined)).rejects.toThrow(
      'clock_task_store.load.unavailable failed: "clock task-store module unavailable"'
    );
    expect(importCoreDist).toHaveBeenCalledTimes(1);
    expect(importCoreDist).toHaveBeenCalledWith('servertool/clock/task-store');
    expect(importCoreDist).not.toHaveBeenCalledWith('servertool/clock/tasks');
    expect(importCoreDist).not.toHaveBeenCalledWith('servertool/clock/config');

    warnSpy.mockRestore();
  });

  it('fails fast when heartbeat task-store runtime api is unavailable', async () => {
    jest.resetModules();

    const importCoreDist = jest.fn(async (subpath: string) => {
      if (subpath === 'servertool/heartbeat/task-store') {
        return {};
      }
      throw new Error(`unexpected:${subpath}`);
    });

    jest.unstable_mockModule(
      '../../../../src/modules/llmswitch/bridge/module-loader.js',
      () => ({
        importCoreDist,
        requireCoreDist: jest.fn()
      })
    );

    const mod = await import('../../../../src/modules/llmswitch/bridge/state-integrations.js');

    await expect(mod.buildHeartbeatInjectTextSnapshot()).rejects.toThrow(
      'heartbeat_task_store.build_inject_text.api_unavailable failed: "buildHeartbeatInjectText not available"'
    );
  });

  it('fails fast instead of returning noop stats center when telemetry module is unavailable', async () => {
    jest.resetModules();

    jest.unstable_mockModule(
      '../../../../src/modules/llmswitch/bridge/module-loader.js',
      () => ({
        importCoreDist: jest.fn(),
        requireCoreDist: jest.fn((subpath: string) => {
          if (subpath === 'telemetry/stats-center') {
            throw new Error('stats load boom');
          }
          throw new Error(`unexpected:${subpath}`);
        })
      })
    );

    const mod = await import('../../../../src/modules/llmswitch/bridge/state-integrations.js');

    expect(() => mod.getStatsCenterSafe()).toThrow(
      'stats_center.load failed: Error: stats load boom'
    );
  });
});
