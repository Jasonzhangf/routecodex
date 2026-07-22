/**
 * Runtime lifecycle bridge surface.
 *
 * Lifecycle decisions stay Rust-owned. This host only marshals JSON plans for
 * TS filesystem, HTTP, signal, and spawn execution shells.
 *
 * canonical_builders:
 * - plan_runtime_pid_cache_write_json
 * - plan_runtime_pid_cache_read_result_json
 * - plan_runtime_stop_intent_write_json
 * - plan_runtime_stop_intent_consume_json
 * - plan_runtime_instance_write_json
 * - plan_runtime_instance_status_update_json
 * - plan_runtime_restart_request_json
 * - plan_runtime_start_restart_takeover_guard_json
 */

import { getRouterHotpathJsonBindingSync } from './native-exports.js';

type RuntimeLifecycleBinding = {
  planRuntimePidCacheWriteJson?: (inputJson: string) => string;
  planRuntimePidCacheReadResultJson?: (inputJson: string) => string;
  planRuntimeStopIntentWriteJson?: (inputJson: string) => string;
  planRuntimeStopIntentConsumeJson?: (inputJson: string) => string;
  planRuntimeInstanceWriteJson?: (inputJson: string) => string;
  planRuntimeInstanceStatusUpdateJson?: (inputJson: string) => string;
  planRuntimeRestartRequestJson?: (inputJson: string) => string;
  planRuntimeStartRestartTakeoverGuardJson?: (inputJson: string) => string;
};

export type RuntimePidCacheRecord = {
  pid: number;
  port: number;
  writtenAtMs: number;
  origin: 'start' | 'resume' | 'snapshot' | string;
};

export type RuntimeStopIntentRecord = {
  port: number;
  requestedAtMs: number;
  source: string;
  pid?: number;
};

export type RuntimeInstanceRecord = {
  port: number;
  host: string;
  command: string;
  configPath: string;
  ownerScope: string;
  startedAtMs: number;
  status: string;
  statusUpdatedAtMs: number;
  notes?: Record<string, string | number | boolean | null>;
};

export type RuntimeRestartRequestPlan = {
  preferredTransport: 'http' | 'signal' | 'none' | string;
  httpFallbackTransport: 'http' | 'signal' | 'none' | string;
  reasonCode: string;
};

export type RuntimeStartRestartTakeoverGuardPlan = {
  action: 'allow' | 'refuse' | string;
  reasonCode: string;
  ports: number[];
};

function getRuntimeLifecycleBinding(): RuntimeLifecycleBinding {
  return getRouterHotpathJsonBindingSync() as RuntimeLifecycleBinding;
}

function callRuntimeLifecyclePlan<T>(name: keyof RuntimeLifecycleBinding, input: unknown): T {
  const binding = getRuntimeLifecycleBinding();
  const fn = binding[name];
  if (typeof fn !== 'function') {
    throw new Error(`[runtime-lifecycle-host] native ${String(name)} is required`);
  }
  const raw = fn(JSON.stringify(input));
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error(`[runtime-lifecycle-host] native ${String(name)} returned empty plan`);
  }
  return JSON.parse(raw) as T;
}

export function planRuntimePidCacheWrite(input: {
  port: number;
  pid: number;
  origin?: RuntimePidCacheRecord['origin'];
  nowMs?: number;
}): { action: 'write'; resourceId: 'runtime.pid_cache'; record: RuntimePidCacheRecord } {
  return callRuntimeLifecyclePlan('planRuntimePidCacheWriteJson', input);
}

export function planRuntimePidCacheReadResult(input: {
  port: number;
  record: unknown;
}): {
  matched: boolean;
  shouldDelete: boolean;
  reasonCode: string;
  record?: RuntimePidCacheRecord;
} {
  return callRuntimeLifecyclePlan('planRuntimePidCacheReadResultJson', input);
}

export function planRuntimeStopIntentWrite(input: {
  port: number;
  source?: string;
  pid?: number;
  requestedAtMs?: number;
}): { action: 'write'; resourceId: 'runtime.stop_intent'; record: RuntimeStopIntentRecord } {
  return callRuntimeLifecyclePlan('planRuntimeStopIntentWriteJson', input);
}

export function planRuntimeStopIntentConsume(input: {
  port: number;
  record: unknown;
  nowMs?: number;
  maxAgeMs?: number;
  ignorePid?: number;
  preserveMatched?: boolean;
}): {
  matched: boolean;
  shouldDelete: boolean;
  reasonCode: string;
  source?: string;
  requestedAtMs?: number;
  pid?: number;
} {
  return callRuntimeLifecyclePlan('planRuntimeStopIntentConsumeJson', input);
}

export function planRuntimeInstanceWrite(input: {
  port: number;
  host: string;
  command: string;
  configPath: string;
  ownerScope: string;
  startedAtMs?: number;
  status?: RuntimeInstanceRecord['status'];
  statusUpdatedAtMs?: number;
  nowMs?: number;
  notes?: RuntimeInstanceRecord['notes'];
}): { action: 'write'; resourceId: 'runtime.instance_record'; record: RuntimeInstanceRecord } {
  return callRuntimeLifecyclePlan('planRuntimeInstanceWriteJson', input);
}

export function planRuntimeInstanceStatusUpdate(input: {
  port: number;
  existing: unknown;
  status: RuntimeInstanceRecord['status'];
  statusUpdatedAtMs?: number;
  nowMs?: number;
  notes?: RuntimeInstanceRecord['notes'];
}): {
  action: 'write' | 'ignore' | string;
  resourceId: 'runtime.instance_record';
  reasonCode: string;
  record?: RuntimeInstanceRecord;
} {
  return callRuntimeLifecyclePlan('planRuntimeInstanceStatusUpdateJson', input);
}

export function planRuntimeRestartRequest(input: {
  oldPids: number[];
  restartApiKey: { source: 'config' | 'env' | 'none'; value: string };
  httpOnly: boolean;
}): RuntimeRestartRequestPlan {
  return callRuntimeLifecyclePlan('planRuntimeRestartRequestJson', input);
}

export function planRuntimeStartRestartTakeoverGuard(input: {
  explicitRestart: boolean;
  noRestart: boolean;
  exclusive: boolean;
  daemonSupervisor: boolean;
  occupiedPorts: number[];
}): RuntimeStartRestartTakeoverGuardPlan {
  return callRuntimeLifecyclePlan('planRuntimeStartRestartTakeoverGuardJson', input);
}
