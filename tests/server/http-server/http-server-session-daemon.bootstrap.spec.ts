import { describe, expect, it, jest } from '@jest/globals';

const mockResolveClockConfigSnapshot = jest.fn();
const mockStartClockDaemonIfNeededSnapshot = jest.fn();
const mockResolveHeartbeatConfigSnapshot = jest.fn();
const mockStartHeartbeatDaemonIfNeededSnapshot = jest.fn();
const mockRunHeartbeatDaemonTickSnapshot = jest.fn();

const mockBridgeModule = () => ({
  resolveClockConfigSnapshot: mockResolveClockConfigSnapshot,
  startClockDaemonIfNeededSnapshot: mockStartClockDaemonIfNeededSnapshot,
  resolveHeartbeatConfigSnapshot: mockResolveHeartbeatConfigSnapshot,
  startHeartbeatDaemonIfNeededSnapshot: mockStartHeartbeatDaemonIfNeededSnapshot,
  runHeartbeatDaemonTickSnapshot: mockRunHeartbeatDaemonTickSnapshot
});

jest.unstable_mockModule('../../../src/modules/llmswitch/bridge.js', mockBridgeModule);
jest.unstable_mockModule('../../../src/modules/llmswitch/bridge.ts', mockBridgeModule);

describe('http-server session daemon bootstrap', () => {
  it('boots the shared clock daemon with exact-match config instead of scanning clock files in host', async () => {
    jest.resetModules();
    mockResolveClockConfigSnapshot.mockReset();
    mockStartClockDaemonIfNeededSnapshot.mockReset();
    mockResolveHeartbeatConfigSnapshot.mockReset();
    mockStartHeartbeatDaemonIfNeededSnapshot.mockReset();
    mockRunHeartbeatDaemonTickSnapshot.mockReset();
    mockResolveClockConfigSnapshot.mockResolvedValue({
      enabled: true,
      retentionMs: 120000,
      dueWindowMs: 60000,
      tickMs: 1500
    });
    mockStartClockDaemonIfNeededSnapshot.mockResolvedValue(true);
    mockResolveHeartbeatConfigSnapshot.mockResolvedValue({ tickMs: 900000 });
    mockStartHeartbeatDaemonIfNeededSnapshot.mockResolvedValue(true);
    mockRunHeartbeatDaemonTickSnapshot.mockResolvedValue(true);

    const { tickSessionDaemonInjectLoop } = await import(
      '../../../src/server/runtime/http-server/http-server-session-daemon.js'
    );

    const server = {
      userConfig: {
        virtualrouter: {
          clock: {
            enabled: true
          },
          heartbeat: {
            tickMs: 900000
          }
        }
      },
      currentRouterArtifacts: null,
      sessionDaemonInjectTickInFlight: false,
      lastSessionDaemonInjectErrorAtMs: 0
    };

    await tickSessionDaemonInjectLoop(server);

    expect(mockResolveClockConfigSnapshot).toHaveBeenCalledWith({ enabled: true });
    expect(mockStartClockDaemonIfNeededSnapshot).toHaveBeenCalledWith({
      enabled: true,
      retentionMs: 120000,
      dueWindowMs: 0,
      tickMs: 1500
    });
    expect(mockResolveHeartbeatConfigSnapshot).toHaveBeenCalledWith({ tickMs: 900000 });
    expect(mockStartHeartbeatDaemonIfNeededSnapshot).toHaveBeenCalledWith({ tickMs: 900000 });
    expect(mockRunHeartbeatDaemonTickSnapshot).toHaveBeenCalled();
    expect(server.sessionDaemonInjectTickInFlight).toBe(false);
  });

  it('boots the shared clock daemon from default llmswitch config even when host config omits clock', async () => {
    jest.resetModules();
    mockResolveClockConfigSnapshot.mockReset();
    mockStartClockDaemonIfNeededSnapshot.mockReset();
    mockResolveHeartbeatConfigSnapshot.mockReset();
    mockStartHeartbeatDaemonIfNeededSnapshot.mockReset();
    mockRunHeartbeatDaemonTickSnapshot.mockReset();

    mockResolveClockConfigSnapshot.mockResolvedValue({
      enabled: true,
      retentionMs: 120000,
      dueWindowMs: 60000,
      tickMs: 1500
    });
    mockStartClockDaemonIfNeededSnapshot.mockResolvedValue(true);
    mockResolveHeartbeatConfigSnapshot.mockResolvedValue({ tickMs: 900000 });
    mockStartHeartbeatDaemonIfNeededSnapshot.mockResolvedValue(true);
    mockRunHeartbeatDaemonTickSnapshot.mockResolvedValue(true);

    const { tickSessionDaemonInjectLoop } = await import(
      '../../../src/server/runtime/http-server/http-server-session-daemon.js'
    );

    const server = {
      userConfig: {},
      currentRouterArtifacts: null,
      sessionDaemonInjectTickInFlight: false,
      lastSessionDaemonInjectErrorAtMs: 0
    };

    await tickSessionDaemonInjectLoop(server);

    expect(mockResolveClockConfigSnapshot).toHaveBeenCalledWith(undefined);
    expect(mockStartClockDaemonIfNeededSnapshot).toHaveBeenCalledWith({
      enabled: true,
      retentionMs: 120000,
      dueWindowMs: 0,
      tickMs: 1500
    });
    expect(server.sessionDaemonInjectTickInFlight).toBe(false);
  });
});
