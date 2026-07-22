import { describe, expect, it } from '@jest/globals';

import { readNativeFunction } from './helpers/native-router-hotpath-loader.js';

function callNativeJson(name: string, input: unknown): Record<string, unknown> {
  const fn = readNativeFunction(name);
  if (typeof fn !== 'function') {
    throw new Error(`${name} missing`);
  }
  const raw = fn(JSON.stringify(input));
  if (typeof raw !== 'string') {
    throw new Error(`${name} returned non-string`);
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${name} returned non-object`);
  }
  return parsed as Record<string, unknown>;
}

describe('runtime lifecycle direct native plans', () => {
  it('plans pid cache records without TS-owned lifecycle semantics', () => {
    const planned = callNativeJson('planRuntimePidCacheWriteJson', {
      port: 5520,
      pid: 12345,
      origin: 'start',
      nowMs: 1700000000000
    });

    expect(planned.action).toBe('write');
    expect(planned.resourceId).toBe('runtime.pid_cache');
    expect(planned.record).toEqual({
      pid: 12345,
      port: 5520,
      writtenAtMs: 1700000000000,
      origin: 'start'
    });

    const read = callNativeJson('planRuntimePidCacheReadResultJson', {
      port: 5520,
      record: planned.record
    });
    expect(read.matched).toBe(true);
    expect(read.record).toEqual(planned.record);
  });

  it('plans stop-intent TTL/reap behavior in native code', () => {
    const write = callNativeJson('planRuntimeStopIntentWriteJson', {
      port: 5521,
      source: 'jest',
      pid: 333,
      requestedAtMs: 1700000000000
    });
    expect(write.action).toBe('write');
    expect(write.resourceId).toBe('runtime.stop_intent');

    const fresh = callNativeJson('planRuntimeStopIntentConsumeJson', {
      port: 5521,
      record: write.record,
      nowMs: 1700000000001,
      maxAgeMs: 60000,
      preserveMatched: true
    });
    expect(fresh).toMatchObject({
      matched: true,
      shouldDelete: false,
      reasonCode: 'matched'
    });

    const stale = callNativeJson('planRuntimeStopIntentConsumeJson', {
      port: 5521,
      record: write.record,
      nowMs: 1700000100000,
      maxAgeMs: 10000
    });
    expect(stale).toMatchObject({
      matched: false,
      shouldDelete: true,
      reasonCode: 'stale'
    });
  });

  it('plans instance registry write and status update records in native code', () => {
    const write = callNativeJson('planRuntimeInstanceWriteJson', {
      port: 5522,
      host: '127.0.0.1',
      command: 'node dist/index.js',
      configPath: '/tmp/config.toml',
      ownerScope: 'jest',
      startedAtMs: 1700000000000,
      nowMs: 1700000000001
    });
    expect(write).toMatchObject({
      action: 'write',
      resourceId: 'runtime.instance_record',
      record: {
        port: 5522,
        host: '127.0.0.1',
        command: 'node dist/index.js',
        configPath: '/tmp/config.toml',
        ownerScope: 'jest',
        startedAtMs: 1700000000000,
        status: 'declared',
        statusUpdatedAtMs: 1700000000001
      }
    });

    const updated = callNativeJson('planRuntimeInstanceStatusUpdateJson', {
      port: 5522,
      existing: write.record,
      status: 'healthy',
      nowMs: 1700000000100,
      notes: { source: 'native-test' }
    });
    expect(updated).toMatchObject({
      action: 'write',
      resourceId: 'runtime.instance_record',
      reasonCode: 'matched',
      record: {
        port: 5522,
        status: 'healthy',
        statusUpdatedAtMs: 1700000000100,
        notes: { source: 'native-test' }
      }
    });

    expect(() => callNativeJson('planRuntimeInstanceStatusUpdateJson', {
      port: 5522,
      existing: updated.record,
      status: 'bind',
      nowMs: 1700000000200
    })).toThrow(/invalid instance status transition healthy -> bind|returned non-string/);

    expect(() => callNativeJson('planRuntimeInstanceWriteJson', {
      port: 5522,
      host: '127.0.0.1',
      command: 'node dist/index.js',
      configPath: '/tmp/config.toml',
      ownerScope: 'jest',
      status: 'starting'
    })).toThrow(/runtime lifecycle status must be one of|returned non-string/);
  });

  it('plans restart transport and explicit start --restart guard in native code', () => {
    const restart = callNativeJson('planRuntimeRestartRequestJson', {
      oldPids: [901],
      restartApiKey: { source: 'none', value: '' },
      httpOnly: false
    });
    expect(restart).toMatchObject({
      preferredTransport: 'signal',
      httpFallbackTransport: 'signal',
      reasonCode: 'local_pid_without_config_apikey'
    });

    const guard = callNativeJson('planRuntimeStartRestartTakeoverGuardJson', {
      explicitRestart: true,
      exclusive: false,
      daemonSupervisor: false,
      occupiedPorts: [5520]
    });
    expect(guard).toMatchObject({
      action: 'allow',
      reasonCode: 'explicit_start_restart_takeover_allowed',
      ports: [5520]
    });

    const defaultStartGuard = callNativeJson('planRuntimeStartRestartTakeoverGuardJson', {
      explicitRestart: false,
      exclusive: false,
      daemonSupervisor: false,
      occupiedPorts: [5521]
    });
    expect(defaultStartGuard).toMatchObject({
      action: 'allow',
      reasonCode: 'default_start_takeover_allowed',
      ports: [5521]
    });

    const noRestartGuard = callNativeJson('planRuntimeStartRestartTakeoverGuardJson', {
      explicitRestart: false,
      noRestart: true,
      exclusive: false,
      daemonSupervisor: false,
      occupiedPorts: [5522]
    } as any);
    expect(noRestartGuard).toMatchObject({
      action: 'refuse',
      reasonCode: 'start_no_restart_requires_stopped_runtime',
      ports: [5522]
    });
  });
});
