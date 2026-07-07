import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from '@jest/globals';

import {
  inferUngracefulPreviousExit,
  resolveRuntimeLifecyclePath,
  safeMarkRuntimeExit,
  safeMarkRuntimeExitSync,
  safeReadRuntimeLifecycle,
  safeWriteRuntimeLifecycle,
  safeWriteRuntimeLifecycleSync,
  type RuntimeLifecycleState
} from '../../src/utils/runtime-exit-forensics.js';

describe('runtime-exit-forensics', () => {
  it('resolves lifecycle file under routecodex state dir', () => {
    const filePath = resolveRuntimeLifecyclePath(5520, '/tmp/rc-home');
    expect(filePath).toBe('/tmp/rc-home/state/runtime-lifecycle/server-5520.json');
  });

  it('reports previous missing-exit marker when pid is not alive', () => {
    const previous: RuntimeLifecycleState = {
      runId: 'run_prev',
      pid: 54321,
      port: 5520,
      startedAt: '2026-02-12T00:00:00.000Z'
    };

    const inference = inferUngracefulPreviousExit({
      previous,
      currentPid: 99999,
      isPidAlive: () => false
    });

    expect(inference.shouldReport).toBe(true);
    expect(inference.reason).toBe('previous_missing_exit_marker_pid_dead');
  });

  it('does not report when previous run already has exit marker', () => {
    const previous: RuntimeLifecycleState = {
      runId: 'run_prev',
      pid: 54321,
      port: 5520,
      startedAt: '2026-02-12T00:00:00.000Z',
      exit: {
        kind: 'signal',
        code: 0,
        signal: 'SIGTERM',
        recordedAt: '2026-02-12T00:10:00.000Z'
      }
    };

    const inference = inferUngracefulPreviousExit({
      previous,
      currentPid: 99999,
      isPidAlive: () => false
    });

    expect(inference.shouldReport).toBe(false);
    expect(inference.reason).toBe('previous_exit_recorded');
  });

  it('writes and marks lifecycle exit state', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-runtime-forensics-'));
    const filePath = resolveRuntimeLifecyclePath(5520, root);

    const wrote = await safeWriteRuntimeLifecycle(filePath, {
      runId: 'run_current',
      pid: 12345,
      port: 5520,
      startedAt: '2026-02-12T01:00:00.000Z',
      buildVersion: '0.89.2000',
      buildMode: 'dev'
    });

    expect(wrote).toBe(true);

    const marked = await safeMarkRuntimeExit(filePath, {
      kind: 'signal',
      code: 0,
      signal: 'SIGTERM',
      recordedAt: '2026-02-12T01:10:00.000Z'
    });

    expect(marked).toBe(true);
    const state = safeReadRuntimeLifecycle(filePath);
    expect(state).toBeTruthy();
    expect(state?.exit?.kind).toBe('signal');
    expect(state?.exit?.signal).toBe('SIGTERM');
  });

  it('writes and marks lifecycle exit state synchronously for process exit handlers', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-runtime-forensics-sync-'));
    const filePath = resolveRuntimeLifecyclePath(5520, root);

    const wrote = safeWriteRuntimeLifecycleSync(filePath, {
      runId: 'run_current_sync',
      pid: 23456,
      port: 5520,
      startedAt: '2026-02-12T02:00:00.000Z',
      buildVersion: '0.89.2001',
      buildMode: 'release'
    });

    expect(wrote).toBe(true);

    const marked = safeMarkRuntimeExitSync(filePath, {
      kind: 'startupError',
      code: 1,
      message: 'native bootstrapVirtualRouterConfigJson is required but unavailable',
      recordedAt: '2026-02-12T02:00:02.000Z'
    });

    expect(marked).toBe(true);
    const state = safeReadRuntimeLifecycle(filePath);
    expect(state?.exit?.kind).toBe('startupError');
    expect(state?.exit?.message).toContain('bootstrapVirtualRouterConfigJson');
  });
});
