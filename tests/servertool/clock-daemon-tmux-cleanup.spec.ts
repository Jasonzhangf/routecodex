import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  normalizeClockConfig,
  runClockDaemonTickForTests,
  scheduleClockTasks,
  setClockRuntimeHooks,
  startClockDaemonIfNeeded,
  stopClockDaemonForTests,
  resetClockRuntimeHooksForTests,
} from '../../sharedmodule/llmswitch-core/src/servertool/clock/task-store.js';
import { resolveClockStateFile } from '../../sharedmodule/llmswitch-core/src/servertool/clock/paths.js';

function resolveStatePath(sessionDir: string, sessionScope: string): string {
  const file = resolveClockStateFile(sessionDir, sessionScope);
  if (!file) {
    throw new Error(`invalid clock session scope: ${sessionScope}`);
  }
  return file;
}

describe('clock daemon tmux lifecycle cleanup policy', () => {
  let sessionDir = '';

  beforeEach(async () => {
    await stopClockDaemonForTests();
    resetClockRuntimeHooksForTests();
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-clock-cleanup-'));
    process.env.ROUTECODEX_SESSION_DIR = sessionDir;
    process.env.ROUTECODEX_SESSION_NTP = '0';
  });

  afterEach(async () => {
    resetClockRuntimeHooksForTests();
    await stopClockDaemonForTests();
    if (sessionDir) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  test('startup tick removes clock state when tmux session is gone', async () => {
    const sessionScope = 'tmux:dead-startup';
    const clockConfig = normalizeClockConfig({ enabled: true, tickMs: 0 });
    if (!clockConfig) {
      throw new Error('clock config should exist');
    }

    await scheduleClockTasks(
      sessionScope,
      [{ dueAtMs: Date.now() + 60_000, task: 'cleanup-at-startup' }],
      clockConfig,
    );

    const statePath = resolveStatePath(sessionDir, sessionScope);
    expect(fs.existsSync(statePath)).toBe(true);

    setClockRuntimeHooks({ isTmuxSessionAlive: () => false });
    await startClockDaemonIfNeeded(clockConfig);

    expect(fs.existsSync(statePath)).toBe(false);
  });

  test('runtime tick only disables state; shutdown tick removes state', async () => {
    const sessionScope = 'tmux:live-then-dead';
    const clockConfig = normalizeClockConfig({ enabled: true, tickMs: 0 });
    if (!clockConfig) {
      throw new Error('clock config should exist');
    }

    await scheduleClockTasks(
      sessionScope,
      [{ dueAtMs: Date.now() + 60_000, task: 'disable-at-runtime' }],
      clockConfig,
    );

    const statePath = resolveStatePath(sessionDir, sessionScope);
    expect(fs.existsSync(statePath)).toBe(true);

    let tmuxAlive = true;
    setClockRuntimeHooks({ isTmuxSessionAlive: () => tmuxAlive });

    await startClockDaemonIfNeeded(clockConfig);
    expect(fs.existsSync(statePath)).toBe(true);

    tmuxAlive = false;
    await runClockDaemonTickForTests();

    expect(fs.existsSync(statePath)).toBe(true);
    const runtimeState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    expect(runtimeState.disabled).toBe(true);
    expect(runtimeState.disabledReason).toBe('tmux_session_not_found');

    await stopClockDaemonForTests();
    expect(fs.existsSync(statePath)).toBe(false);
  });
});
