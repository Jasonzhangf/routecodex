import { describe, expect, it, jest } from '@jest/globals';

const mockResolveClockConfigSnapshot = jest.fn();
const mockStartClockDaemonIfNeededSnapshot = jest.fn();

const mockBridgeModule = () => ({
  resolveClockConfigSnapshot: mockResolveClockConfigSnapshot,
  startClockDaemonIfNeededSnapshot: mockStartClockDaemonIfNeededSnapshot
});

jest.unstable_mockModule('../../../src/modules/llmswitch/bridge.js', mockBridgeModule);
jest.unstable_mockModule('../../../src/modules/llmswitch/bridge.ts', mockBridgeModule);

describe('http-server session daemon bootstrap', () => {
  it('boots the shared clock daemon with exact-match config instead of scanning clock files in host', async () => {
    jest.resetModules();
    mockResolveClockConfigSnapshot.mockReset();
    mockStartClockDaemonIfNeededSnapshot.mockReset();
    mockResolveClockConfigSnapshot.mockResolvedValue({
      enabled: true,
      retentionMs: 120000,
      dueWindowMs: 60000,
      tickMs: 1500
    });
    mockStartClockDaemonIfNeededSnapshot.mockResolvedValue(true);

    const { tickSessionDaemonInjectLoop } = await import(
      '../../../src/server/runtime/http-server/http-server-session-daemon.js'
    );

    const server = {
      userConfig: {
        virtualrouter: {
          clock: {
            enabled: true
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
    expect(server.sessionDaemonInjectTickInFlight).toBe(false);
  });
});
