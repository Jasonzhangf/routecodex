/**
 * Traffic Governor — TS Bridge
 *
 * 独立的基础设施组件，跨进程流量治理。
 * 不内嵌在 Hub Pipeline 中，通过独立模块调用。
 *
 * MetadataCenter runtime_control.trafficGovernor.* 作为唯一配置入口。
 */

import { getRouterHotpathJsonBindingSync } from '../llmswitch/bridge/traffic-governor-host.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TrafficGovernorPermit {
  runtimeKey: string;
  providerKey?: string;
  requestId: string;
  leaseId: string;
  stateKey: string;
  scopeKey?: string;
  maxInFlight: number;
  pid: number;
  serverId: string;
  startedAt: number;
  expiresAt: number;
}

export interface TrafficGovernorPolicy {
  maxInFlight: number;
  acquireTimeoutMs: number;
  staleLeaseMs: number;
  requestsPerMinute: number;
  rpmTimeoutMs: number;
  rpmWindowMs: number;
}

export interface TrafficGovernorAcquireResult {
  permit: TrafficGovernorPermit;
  policy: TrafficGovernorPolicy;
  waitedMs: number;
  activeInFlight: number;
  rpmInWindow: number;
}

export interface TrafficGovernorReleaseResult {
  released: boolean;
  activeInFlight: number;
}

export interface TrafficGovernorAcquireOptions {
  runtimeKey: string;
  providerKey?: string;
  requestId: string;
  scopeKey?: string;
  maxInFlight?: number;
  acquireTimeoutMs?: number;
  staleLeaseMs?: number;
  requestsPerMinute?: number;
  rpmTimeoutMs?: number;
  storeRoot?: string;
}

export interface TrafficGovernorReleaseOptions {
  runtimeKey: string;
  requestId: string;
  leaseId: string;
  stateKey: string;
  storeRoot?: string;
}

// ---------------------------------------------------------------------------
// Traffic Governor — 全局单例接口
// ---------------------------------------------------------------------------

const DEFAULT_STORE_ROOT = '/tmp/routecodex-traffic';

function getBinding() {
  return getRouterHotpathJsonBindingSync();
}

export function trafficGovernorAcquire(
  options: TrafficGovernorAcquireOptions
): TrafficGovernorAcquireResult {
  const binding = getBinding();
  const fn = binding.trafficGovernorAcquireJson;
  if (typeof fn !== 'function') {
    throw new Error('[traffic-governor] trafficGovernorAcquireJson not available');
  }
  const raw = fn(JSON.stringify({
    ...options,
    storeRoot: options.storeRoot ?? DEFAULT_STORE_ROOT,
  }));
  return JSON.parse(raw) as TrafficGovernorAcquireResult;
}

export function trafficGovernorRelease(
  options: TrafficGovernorReleaseOptions
): TrafficGovernorReleaseResult {
  const binding = getBinding();
  const fn = binding.trafficGovernorReleaseJson;
  if (typeof fn !== 'function') {
    throw new Error('[traffic-governor] trafficGovernorReleaseJson not available');
  }
  const raw = fn(JSON.stringify({
    ...options,
    storeRoot: options.storeRoot ?? DEFAULT_STORE_ROOT,
  }));
  return JSON.parse(raw) as TrafficGovernorReleaseResult;
}

export function trafficGovernorIsAtCapacity(
  runtimeKey: string,
  storeRoot?: string
): boolean {
  const binding = getBinding();
  const fn = binding.trafficGovernorIsAtCapacityJson;
  if (typeof fn !== 'function') {
    throw new Error('[traffic-governor] trafficGovernorIsAtCapacityJson not available');
  }
  return fn(JSON.stringify({
    runtimeKey,
    storeRoot: storeRoot ?? DEFAULT_STORE_ROOT,
  }));
}

export function trafficGovernorObserveOutcome(options: {
  runtimeKey: string;
  providerKey?: string;
  requestId?: string;
  success: boolean;
  statusCode?: number;
  errorCode?: string;
  upstreamCode?: string;
  reason?: string;
  activeInFlight?: number;
  storeRoot?: string;
}): void {
  const binding = getBinding();
  const fn = binding.trafficGovernorObserveOutcomeJson;
  if (typeof fn !== 'function') {
    throw new Error('[traffic-governor] trafficGovernorObserveOutcomeJson not available');
  }
  fn(JSON.stringify({
    ...options,
    storeRoot: options.storeRoot ?? DEFAULT_STORE_ROOT,
  }));
}
