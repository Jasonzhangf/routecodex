/**
 * Traffic Governor — TS Bridge
 *
 * 独立的基础设施组件，跨进程流量治理。
 * 不内嵌在 Hub Pipeline 中，通过独立模块调用。
 *
 * MetadataCenter runtime_control.trafficGovernor.* 作为唯一配置入口。
 */

import {
  trafficGovernorAcquireNativeJson,
  trafficGovernorIsAtCapacityNativeJson,
  trafficGovernorObserveOutcomeNativeJson,
  trafficGovernorReleaseNativeJson,
} from '../llmswitch/bridge/traffic-governor-host.js';

export const TRAFFIC_ADMISSION_LANE_FEATURE_ID = 'feature_id: error.traffic_admission_lane';

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

export type TrafficAdmissionLane = 'concurrency' | 'rpm';

export interface TrafficAdmissionBackpressure {
  code: 'TRAFFIC_ADMISSION_BACKPRESSURE';
  lane: TrafficAdmissionLane;
  runtimeKey: string;
  stateKey: string;
  timeoutMs: number;
  waitedMs: number;
  current: number;
  limit: number;
}

export class TrafficAdmissionBackpressureError extends Error {
  readonly code = 'TRAFFIC_ADMISSION_BACKPRESSURE' as const;
  readonly routecodexErrorKind = 'traffic_admission_backpressure' as const;
  readonly retryable = false;
  readonly lane: TrafficAdmissionLane;
  readonly runtimeKey: string;
  readonly stateKey: string;
  readonly timeoutMs: number;
  readonly waitedMs: number;
  readonly current: number;
  readonly limit: number;

  constructor(backpressure: TrafficAdmissionBackpressure) {
    super(
      `traffic admission timed out in ${backpressure.lane} lane for `
      + `${backpressure.runtimeKey} after ${backpressure.waitedMs}ms`
    );
    this.name = 'TrafficAdmissionBackpressureError';
    this.lane = backpressure.lane;
    this.runtimeKey = backpressure.runtimeKey;
    this.stateKey = backpressure.stateKey;
    this.timeoutMs = backpressure.timeoutMs;
    this.waitedMs = backpressure.waitedMs;
    this.current = backpressure.current;
    this.limit = backpressure.limit;
  }
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
  rpmWindowMs?: number;
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
// Traffic Governor — Rust-owned process-shared admission interface
// ---------------------------------------------------------------------------

const DEFAULT_STORE_ROOT = '/tmp/routecodex-traffic';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function parseBackpressure(value: unknown): TrafficAdmissionBackpressure | undefined {
  if (!isRecord(value)) return undefined;
  const lane = value.lane;
  if (
    value.code !== 'TRAFFIC_ADMISSION_BACKPRESSURE'
    || (lane !== 'concurrency' && lane !== 'rpm')
    || typeof value.runtimeKey !== 'string'
    || typeof value.stateKey !== 'string'
    || typeof value.timeoutMs !== 'number'
    || typeof value.waitedMs !== 'number'
    || typeof value.current !== 'number'
    || typeof value.limit !== 'number'
  ) {
    throw new Error('[traffic-governor] malformed traffic admission backpressure');
  }
  return value as unknown as TrafficAdmissionBackpressure;
}

export function isTrafficAdmissionBackpressureError(
  error: unknown
): error is TrafficAdmissionBackpressureError {
  return error instanceof TrafficAdmissionBackpressureError
    || (
      isRecord(error)
      && error.code === 'TRAFFIC_ADMISSION_BACKPRESSURE'
      && error.routecodexErrorKind === 'traffic_admission_backpressure'
    );
}

export async function trafficGovernorAcquire(
  options: TrafficGovernorAcquireOptions
): Promise<TrafficGovernorAcquireResult> {
  const raw = await trafficGovernorAcquireNativeJson(JSON.stringify({
    ...options,
    storeRoot: options.storeRoot ?? DEFAULT_STORE_ROOT,
  }));
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    throw new Error('[traffic-governor] malformed traffic governor acquire result');
  }
  const backpressure = parseBackpressure(parsed.backpressure);
  if (backpressure) {
    throw new TrafficAdmissionBackpressureError(backpressure);
  }
  return parsed as unknown as TrafficGovernorAcquireResult;
}

export function trafficGovernorRelease(
  options: TrafficGovernorReleaseOptions
): TrafficGovernorReleaseResult {
  const raw = trafficGovernorReleaseNativeJson(JSON.stringify({
    ...options,
    storeRoot: options.storeRoot ?? DEFAULT_STORE_ROOT,
  }));
  return JSON.parse(raw) as TrafficGovernorReleaseResult;
}

export function trafficGovernorIsAtCapacity(
  runtimeKey: string,
  storeRoot?: string,
  scopeKey?: string,
  maxInFlight?: number
): boolean {
  return trafficGovernorIsAtCapacityNativeJson(JSON.stringify({
    runtimeKey,
    ...(scopeKey ? { scopeKey } : {}),
    ...(typeof maxInFlight === 'number' ? { maxInFlight } : {}),
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
  trafficGovernorObserveOutcomeNativeJson(JSON.stringify({
    ...options,
    storeRoot: options.storeRoot ?? DEFAULT_STORE_ROOT,
  }));
}
