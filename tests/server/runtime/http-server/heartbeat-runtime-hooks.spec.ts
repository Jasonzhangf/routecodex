import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, jest } from '@jest/globals';

describe('heartbeat-runtime-hooks', () => {
  it('skips heartbeat injection when tmux session is still active in pane state', async () => {
    jest.resetModules();

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-heartbeat-hooks-'));
    fs.writeFileSync(
      path.join(tmpDir, 'HEARTBEAT.md'),
      '# Heartbeat\nHeartbeat-Until: 2099-01-01T00:00:00Z\n',
      'utf8'
    );

    const injectSessionClientPromptWithResult = jest.fn(async () => ({ ok: true as const }));

    await jest.unstable_mockModule('../../../../src/server/runtime/http-server/session-client-registry.js', () => ({
      getSessionClientRegistry: () => ({
        hasAliveTmuxSession: () => false
      }),
      injectSessionClientPromptWithResult
    }));

    await jest.unstable_mockModule('../../../../src/server/runtime/http-server/tmux-session-probe.js', () => ({
      isTmuxSessionAlive: () => true,
      isTmuxSessionIdleForInject: () => false,
      resolveTmuxSessionWorkingDirectory: () => tmpDir
    }));

    const mod = await import('../../../../src/server/runtime/http-server/heartbeat-runtime-hooks.js');
    const result = await mod.dispatchSingleHeartbeat({
      tmuxSessionId: 'tmux_busy_1',
      injectText: '[Heartbeat]',
      requestActivityTracker: {
        countActiveRequestsForTmuxSession: () => 0
      }
    });

    expect(result).toEqual({
      ok: false,
      skipped: true,
      reason: 'tmux_session_active'
    });
    expect(injectSessionClientPromptWithResult).not.toHaveBeenCalled();

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
