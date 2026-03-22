import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, jest } from '@jest/globals';

describe('heartbeat-runtime-hooks', () => {
  it('allows heartbeat injection when client is connected but execution-state is explicitly idle', async () => {
    jest.resetModules();

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-heartbeat-connected-idle-'));
    fs.writeFileSync(
      path.join(tmpDir, 'HEARTBEAT.md'),
      '# Heartbeat\nHeartbeat-Until: 2099-01-01T00:00:00Z\n',
      'utf8'
    );

    const injectSessionClientPromptWithResult = jest.fn(async () => ({ ok: true as const }));

    await jest.unstable_mockModule('../../../../src/server/runtime/http-server/session-client-registry.js', () => ({
      getSessionClientRegistry: () => ({
        hasAliveTmuxSession: () => true
      }),
      injectSessionClientPromptWithResult
    }));

    await jest.unstable_mockModule('../../../../src/server/runtime/http-server/tmux-session-probe.js', () => ({
      isTmuxSessionAlive: () => true,
      isTmuxSessionIdleForInject: () => true,
      resolveTmuxSessionWorkingDirectory: () => tmpDir
    }));

    await jest.unstable_mockModule('../../../../src/server/runtime/http-server/session-execution-state.js', () => ({
      getSessionExecutionStateTracker: () => ({
        getStateSnapshot: () => ({
          tmuxSessionId: 'tmux_connected_idle',
          state: 'IDLE',
          shouldSkipHeartbeat: false,
          reason: 'latest_response_stop',
          openSseCount: 0
        })
      })
    }));

    const mod = await import('../../../../src/server/runtime/http-server/heartbeat-runtime-hooks.js');
    const result = await mod.dispatchSingleHeartbeat({
      tmuxSessionId: 'tmux_connected_idle',
      injectText: '[Heartbeat]',
      requestActivityTracker: {
        countActiveRequestsForTmuxSession: () => 0
      }
    });

    expect(result).toMatchObject({
      ok: true,
      workdir: tmpDir
    });
    expect(injectSessionClientPromptWithResult).toHaveBeenCalledTimes(1);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('keeps conservative skip when client is connected and execution-state is unknown', async () => {
    jest.resetModules();

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-heartbeat-connected-unknown-'));
    fs.writeFileSync(
      path.join(tmpDir, 'HEARTBEAT.md'),
      '# Heartbeat\nHeartbeat-Until: 2099-01-01T00:00:00Z\n',
      'utf8'
    );

    const injectSessionClientPromptWithResult = jest.fn(async () => ({ ok: true as const }));

    await jest.unstable_mockModule('../../../../src/server/runtime/http-server/session-client-registry.js', () => ({
      getSessionClientRegistry: () => ({
        hasAliveTmuxSession: () => true
      }),
      injectSessionClientPromptWithResult
    }));

    await jest.unstable_mockModule('../../../../src/server/runtime/http-server/tmux-session-probe.js', () => ({
      isTmuxSessionAlive: () => true,
      isTmuxSessionIdleForInject: () => true,
      resolveTmuxSessionWorkingDirectory: () => tmpDir
    }));

    await jest.unstable_mockModule('../../../../src/server/runtime/http-server/session-execution-state.js', () => ({
      getSessionExecutionStateTracker: () => ({
        getStateSnapshot: () => ({
          tmuxSessionId: 'tmux_connected_unknown',
          state: 'UNKNOWN',
          shouldSkipHeartbeat: false,
          reason: 'no_state',
          openSseCount: 0
        })
      })
    }));

    const mod = await import('../../../../src/server/runtime/http-server/heartbeat-runtime-hooks.js');
    const result = await mod.dispatchSingleHeartbeat({
      tmuxSessionId: 'tmux_connected_unknown',
      injectText: '[Heartbeat]',
      requestActivityTracker: {
        countActiveRequestsForTmuxSession: () => 0
      }
    });

    expect(result).toMatchObject({
      ok: false,
      skipped: true,
      reason: 'client_connected_unknown_state'
    });
    expect(injectSessionClientPromptWithResult).not.toHaveBeenCalled();

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('skips heartbeat injection when execution-state tracker reports active work', async () => {
    jest.resetModules();

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-heartbeat-exec-state-'));
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
      isTmuxSessionIdleForInject: () => true,
      resolveTmuxSessionWorkingDirectory: () => tmpDir
    }));

    await jest.unstable_mockModule('../../../../src/server/runtime/http-server/session-execution-state.js', () => ({
      getSessionExecutionStateTracker: () => ({
        getStateSnapshot: () => ({
          tmuxSessionId: 'tmux_busy_exec',
          state: 'STREAMING_OPEN',
          shouldSkipHeartbeat: true,
          reason: 'sse_open',
          openSseCount: 1
        })
      })
    }));

    const mod = await import('../../../../src/server/runtime/http-server/heartbeat-runtime-hooks.js');
    const result = await mod.dispatchSingleHeartbeat({
      tmuxSessionId: 'tmux_busy_exec',
      injectText: '[Heartbeat]',
      requestActivityTracker: {
        countActiveRequestsForTmuxSession: () => 0
      }
    });

    expect(result).toMatchObject({
      ok: false,
      skipped: true,
      reason: 'session_execution_active',
      state: 'STREAMING_OPEN',
      activityReason: 'sse_open'
    });
    expect(injectSessionClientPromptWithResult).not.toHaveBeenCalled();

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

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

    await jest.unstable_mockModule('../../../../src/server/runtime/http-server/session-execution-state.js', () => ({
      getSessionExecutionStateTracker: () => ({
        getStateSnapshot: () => ({
          tmuxSessionId: 'tmux_busy_1',
          state: 'IDLE',
          shouldSkipHeartbeat: false,
          reason: 'latest_response_stop',
          openSseCount: 0
        })
      })
    }));

    const mod = await import('../../../../src/server/runtime/http-server/heartbeat-runtime-hooks.js');
    const result = await mod.dispatchSingleHeartbeat({
      tmuxSessionId: 'tmux_busy_1',
      injectText: '[Heartbeat]',
      requestActivityTracker: {
        countActiveRequestsForTmuxSession: () => 0
      }
    });

    expect(result).toMatchObject({
      ok: false,
      skipped: true,
      reason: 'tmux_session_active'
    });
    expect(injectSessionClientPromptWithResult).not.toHaveBeenCalled();

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('auto-disables heartbeat when HEARTBEAT.md stop policy is no-open-tasks and checklist is complete', async () => {
    jest.resetModules();

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-heartbeat-stop-when-complete-'));
    fs.writeFileSync(
      path.join(tmpDir, 'HEARTBEAT.md'),
      [
        '# Heartbeat',
        'Heartbeat-Until: 2099-01-01T00:00:00Z',
        'Heartbeat-Stop-When: no-open-tasks',
        '',
        '- [x] done-a',
        '- [x] done-b',
        ''
      ].join('\n'),
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
      isTmuxSessionIdleForInject: () => true,
      resolveTmuxSessionWorkingDirectory: () => tmpDir
    }));

    await jest.unstable_mockModule('../../../../src/server/runtime/http-server/session-execution-state.js', () => ({
      getSessionExecutionStateTracker: () => ({
        getStateSnapshot: () => ({
          tmuxSessionId: 'tmux_stop_when_complete',
          state: 'IDLE',
          shouldSkipHeartbeat: false,
          reason: 'latest_response_stop',
          openSseCount: 0
        })
      })
    }));

    const mod = await import('../../../../src/server/runtime/http-server/heartbeat-runtime-hooks.js');
    const result = await mod.dispatchSingleHeartbeat({
      tmuxSessionId: 'tmux_stop_when_complete',
      injectText: '[Heartbeat]',
      requestActivityTracker: {
        countActiveRequestsForTmuxSession: () => 0
      }
    });

    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        disable: true,
        reason: 'heartbeat_all_tasks_completed'
      })
    );
    expect(injectSessionClientPromptWithResult).not.toHaveBeenCalled();

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('auto-disables heartbeat when HEARTBEAT.md stop policy is no-open-tasks but no checklist exists', async () => {
    jest.resetModules();

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-heartbeat-stop-when-empty-'));
    fs.writeFileSync(
      path.join(tmpDir, 'HEARTBEAT.md'),
      [
        '# Heartbeat',
        'Heartbeat-Until: 2099-01-01T00:00:00Z',
        'Heartbeat-Stop-When: no-open-tasks',
        '',
        'No checklist tasks here.',
        ''
      ].join('\n'),
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
      isTmuxSessionIdleForInject: () => true,
      resolveTmuxSessionWorkingDirectory: () => tmpDir
    }));

    await jest.unstable_mockModule('../../../../src/server/runtime/http-server/session-execution-state.js', () => ({
      getSessionExecutionStateTracker: () => ({
        getStateSnapshot: () => ({
          tmuxSessionId: 'tmux_stop_when_empty',
          state: 'IDLE',
          shouldSkipHeartbeat: false,
          reason: 'latest_response_stop',
          openSseCount: 0
        })
      })
    }));

    const mod = await import('../../../../src/server/runtime/http-server/heartbeat-runtime-hooks.js');
    const result = await mod.dispatchSingleHeartbeat({
      tmuxSessionId: 'tmux_stop_when_empty',
      injectText: '[Heartbeat]',
      requestActivityTracker: {
        countActiveRequestsForTmuxSession: () => 0
      }
    });

    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        disable: true,
        reason: 'heartbeat_no_tasks'
      })
    );
    expect(injectSessionClientPromptWithResult).not.toHaveBeenCalled();

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
