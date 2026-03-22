import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  cleanupSessionStorageOnShutdown,
  cleanupSessionStorageOnStartup
} from '../../../src/server/runtime/http-server/session-storage-cleanup.js';

describe('session storage startup cleanup', () => {
  let baseDir = '';

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-session-cleanup-'));
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  test('removes legacy scope files, dead tmux state, and stale registry entries', () => {
    fs.writeFileSync(path.join(baseDir, 'session-old.json'), '{"version":1}', 'utf8');
    fs.writeFileSync(path.join(baseDir, 'conversation-old.json'), '{"version":1}', 'utf8');
    fs.writeFileSync(path.join(baseDir, 'tmux-dead-tmux.json'), '{"version":1}', 'utf8');
    fs.writeFileSync(path.join(baseDir, 'tmux-live-tmux.json'), '{"version":1}', 'utf8');
    const heartbeatDir = path.join(baseDir, 'heartbeat');
    fs.mkdirSync(heartbeatDir, { recursive: true });
    fs.writeFileSync(path.join(heartbeatDir, 'dead-tmux.json'), '{"version":1}', 'utf8');
    fs.writeFileSync(path.join(heartbeatDir, 'live-tmux.json'), '{"version":1}', 'utf8');

    const keepDir = path.join(baseDir, '127.0.0.1_5520');
    fs.mkdirSync(keepDir, { recursive: true });
    fs.writeFileSync(
      path.join(keepDir, 'session-bindings.json'),
      JSON.stringify({
        updatedAtMs: 200,
        records: [
          {
            daemonId: 'daemon-live',
            callbackUrl: 'http://127.0.0.1:9999/inject',
            tmuxSessionId: 'live-tmux',
            lastHeartbeatAtMs: 195
          },
          {
            daemonId: 'daemon-dead',
            callbackUrl: 'http://127.0.0.1:9999/inject',
            tmuxSessionId: 'dead-tmux',
            lastHeartbeatAtMs: 195
          },
          {
            daemonId: 'daemon-no-tmux',
            callbackUrl: 'http://127.0.0.1:9999/inject',
            lastHeartbeatAtMs: 195
          },
          {
            daemonId: 'daemon-stale',
            callbackUrl: 'http://127.0.0.1:9999/inject',
            tmuxSessionId: 'live-tmux',
            lastHeartbeatAtMs: 10
          }
        ],
        conversationToTmuxSession: {
          'conv-live': 'live-tmux',
          'conv-dead': 'dead-tmux'
        }
      }, null, 2),
      'utf8'
    );
    fs.writeFileSync(
      path.join(keepDir, 'tmux-tools-state.json'),
      JSON.stringify({
        version: 1,
        updatedAtMs: 200,
        heartbeats: {
          'live-tmux': { enabled: true, updatedAtMs: 199 },
          'dead-tmux': { enabled: true, updatedAtMs: 199 }
        },
        injections: {
          'live-tmux': { lastInjectAtMs: 198 },
          'dead-tmux': { lastInjectAtMs: 198 }
        }
      }, null, 2),
      'utf8'
    );

    const removeDir = path.join(baseDir, '127.0.0.1_5555');
    fs.mkdirSync(removeDir, { recursive: true });
    fs.writeFileSync(
      path.join(removeDir, 'session-bindings.json'),
      JSON.stringify({
        updatedAtMs: 200,
        records: [
          {
            daemonId: 'daemon-only-dead',
            callbackUrl: 'http://127.0.0.1:9999/inject',
            tmuxSessionId: 'dead-tmux',
            lastHeartbeatAtMs: 195
          }
        ],
        conversationToTmuxSession: {
          'conv-dead': 'dead-tmux'
        }
      }, null, 2),
      'utf8'
    );

    const summary = cleanupSessionStorageOnStartup({
      baseDir,
      nowMs: 200,
      staleAfterMs: 50,
      isTmuxSessionAlive: (tmuxSessionId) => tmuxSessionId === 'live-tmux'
    });

    expect(summary.removedLegacyScopeFiles).toBe(2);
    expect(summary.removedDeadTmuxStateFiles).toBe(1);
    expect(summary.removedHeartbeatStateFiles).toBe(1);
    expect(summary.removedRegistryRecords).toBe(4);
    expect(summary.removedRegistryMappings).toBe(2);
    expect(summary.removedToolStateEntries).toBe(2);

    expect(fs.existsSync(path.join(baseDir, 'session-old.json'))).toBe(false);
    expect(fs.existsSync(path.join(baseDir, 'conversation-old.json'))).toBe(false);
    expect(fs.existsSync(path.join(baseDir, 'tmux-dead-tmux.json'))).toBe(false);
    expect(fs.existsSync(path.join(baseDir, 'tmux-live-tmux.json'))).toBe(true);
    expect(fs.existsSync(path.join(heartbeatDir, 'dead-tmux.json'))).toBe(false);
    expect(fs.existsSync(path.join(heartbeatDir, 'live-tmux.json'))).toBe(true);

    const keptBindings = JSON.parse(fs.readFileSync(path.join(keepDir, 'session-bindings.json'), 'utf8'));
    expect(keptBindings.records).toHaveLength(1);
    expect(keptBindings.records[0].daemonId).toBe('daemon-live');
    expect(keptBindings.conversationToTmuxSession).toEqual({ 'conv-live': 'live-tmux' });

    const keptToolState = JSON.parse(fs.readFileSync(path.join(keepDir, 'tmux-tools-state.json'), 'utf8'));
    expect(Object.keys(keptToolState.heartbeats)).toEqual(['live-tmux']);
    expect(Object.keys(keptToolState.injections)).toEqual(['live-tmux']);

    expect(fs.existsSync(removeDir)).toBe(false);
  });

  test('preserves mappings and tmux tool state for live tmux even when daemon heartbeat is stale', () => {
    const keepDir = path.join(baseDir, '127.0.0.1_5520');
    fs.mkdirSync(keepDir, { recursive: true });
    fs.writeFileSync(
      path.join(keepDir, 'session-bindings.json'),
      JSON.stringify({
        updatedAtMs: 200,
        records: [
          {
            daemonId: 'daemon-stale-live',
            callbackUrl: 'http://127.0.0.1:9999/inject',
            tmuxSessionId: 'live-tmux',
            lastHeartbeatAtMs: 10
          }
        ],
        conversationToTmuxSession: {
          'conv-live': 'live-tmux'
        }
      }, null, 2),
      'utf8'
    );
    fs.writeFileSync(
      path.join(keepDir, 'tmux-tools-state.json'),
      JSON.stringify({
        version: 1,
        updatedAtMs: 200,
        heartbeats: {
          'live-tmux': { enabled: true, updatedAtMs: 199 }
        },
        injections: {
          'live-tmux': { lastInjectAtMs: 198 }
        }
      }, null, 2),
      'utf8'
    );

    const summary = cleanupSessionStorageOnStartup({
      baseDir,
      nowMs: 200,
      staleAfterMs: 50,
      isTmuxSessionAlive: (tmuxSessionId) => tmuxSessionId === 'live-tmux'
    });

    expect(summary.removedRegistryRecords).toBe(1);
    expect(summary.removedRegistryMappings).toBe(0);
    expect(summary.removedToolStateEntries).toBe(0);

    const keptBindings = JSON.parse(fs.readFileSync(path.join(keepDir, 'session-bindings.json'), 'utf8'));
    expect(keptBindings.records).toEqual([]);
    expect(keptBindings.conversationToTmuxSession).toEqual({ 'conv-live': 'live-tmux' });

    const keptToolState = JSON.parse(fs.readFileSync(path.join(keepDir, 'tmux-tools-state.json'), 'utf8'));
    expect(Object.keys(keptToolState.heartbeats)).toEqual(['live-tmux']);
    expect(Object.keys(keptToolState.injections)).toEqual(['live-tmux']);
  });

  test('cleans clock state files for dead tmux sessions on startup and shutdown', () => {
    const rootClockDir = path.join(baseDir, 'clock');
    const nestedClockDir = path.join(baseDir, '127.0.0.1_5520', 'clock');
    fs.mkdirSync(rootClockDir, { recursive: true });
    fs.mkdirSync(nestedClockDir, { recursive: true });
    fs.writeFileSync(path.join(rootClockDir, 'tmux:dead-tmux.json'), '{"tmuxSessionId":"dead-tmux"}', 'utf8');
    fs.writeFileSync(path.join(rootClockDir, 'tmux:live-tmux.json'), '{"tmuxSessionId":"live-tmux"}', 'utf8');
    fs.writeFileSync(path.join(nestedClockDir, 'tmux:dead-tmux.json'), '{"tmuxSessionId":"dead-tmux"}', 'utf8');
    fs.writeFileSync(path.join(nestedClockDir, 'tmux:live-tmux.json'), '{"tmuxSessionId":"live-tmux"}', 'utf8');
    fs.writeFileSync(path.join(rootClockDir, 'ntp-state.json'), '{"offsetMs":0}', 'utf8');

    const startupSummary = cleanupSessionStorageOnStartup({
      baseDir,
      isTmuxSessionAlive: (tmuxSessionId) => tmuxSessionId === 'live-tmux'
    });
    expect(startupSummary.removedClockStateFiles).toBe(2);
    expect(fs.existsSync(path.join(rootClockDir, 'tmux:dead-tmux.json'))).toBe(false);
    expect(fs.existsSync(path.join(nestedClockDir, 'tmux:dead-tmux.json'))).toBe(false);
    expect(fs.existsSync(path.join(rootClockDir, 'tmux:live-tmux.json'))).toBe(true);
    expect(fs.existsSync(path.join(nestedClockDir, 'tmux:live-tmux.json'))).toBe(true);
    expect(fs.existsSync(path.join(rootClockDir, 'ntp-state.json'))).toBe(true);

    fs.writeFileSync(path.join(rootClockDir, 'tmux:dead-tmux-2.json'), '{"tmuxSessionId":"dead-tmux"}', 'utf8');
    const shutdownSummary = cleanupSessionStorageOnShutdown({
      baseDir,
      isTmuxSessionAlive: (tmuxSessionId) => tmuxSessionId === 'live-tmux'
    });
    expect(shutdownSummary.removedClockStateFiles).toBe(1);
    expect(fs.existsSync(path.join(rootClockDir, 'tmux:dead-tmux-2.json'))).toBe(false);
  });
});
