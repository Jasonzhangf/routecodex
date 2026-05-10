import type { PipelineExecutionResult } from '../../../handlers/types.js';
import type { ProviderHandle } from '../types.js';
import type { ProviderRuntimeProfile } from '../../../../providers/core/api/provider-types.js';
import type { ProviderTrafficGovernorLike, ProviderTrafficPermit } from '../provider-traffic-governor.js';
import { recordVirtualRouterHitRollup } from './log-rollup.js';
import { writeErrorsampleJson } from '../../../../utils/errorsamples.js';
import { truncateReason } from './request-executor-error-shared.js';

export const REQUEST_EXECUTOR_NON_BLOCKING_LOG_THROTTLE_MS = 60_000;

export type StoplessLogMode = 'on' | 'off' | 'endless';

export type StoplessLogState = {
  mode?: StoplessLogMode;
  armed?: boolean;
};

export function formatRequestExecutorUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || `${error.name}: ${error.message}`;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function cloneErrorForRequestExecutorReporting(error: unknown): unknown {
  if (!error || typeof error !== 'object') {
    return error;
  }
  if (error instanceof Error) {
    const cloned = new Error(error.message);
    cloned.name = error.name;
    if (typeof error.stack === 'string') {
      cloned.stack = error.stack;
    }
    return Object.assign(cloned, error);
  }
  if (Array.isArray(error)) {
    return [...error];
  }
  return { ...(error as Record<string, unknown>) };
}

export function logRequestExecutorNonBlockingErrorBlock(args: {
  stage: string;
  error: unknown;
  details?: Record<string, unknown>;
  throttleState: Map<string, number>;
  throttleMs?: number;
}): void {
  const now = Date.now();
  const throttleMs = args.throttleMs ?? REQUEST_EXECUTOR_NON_BLOCKING_LOG_THROTTLE_MS;
  const last = args.throttleState.get(args.stage) ?? 0;
  if (now - last < throttleMs) {
    return;
  }
  args.throttleState.set(args.stage, now);
  try {
    const detailSuffix =
      args.details && Object.keys(args.details).length > 0 ? ` details=${JSON.stringify(args.details)}` : '';
    console.warn(
      `[request-executor] ${args.stage} failed (non-blocking): ${formatRequestExecutorUnknownError(args.error)}${detailSuffix}`
    );
  } catch {
    // Never throw from non-blocking logging.
  }
}

export function readRequestExecutorStatusCodeCandidate(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d{3}$/.test(trimmed)) {
      const parsed = Number.parseInt(trimmed, 10);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

export function resolveRequestExecutorTrafficRuntimeProfile(
  runtimeKey: string,
  handle: ProviderHandle,
  providerKey?: string
): ProviderRuntimeProfile {
  const runtimeCandidate = handle.runtime as ProviderRuntimeProfile | undefined;
  if (runtimeCandidate && typeof runtimeCandidate === 'object') {
    return runtimeCandidate;
  }
  const providerIdFallback = (() => {
    if (typeof handle.providerId === 'string' && handle.providerId.trim()) {
      return handle.providerId.trim();
    }
    if (typeof providerKey === 'string' && providerKey.includes('.')) {
      const [head] = providerKey.split('.');
      if (head && head.trim()) {
        return head.trim();
      }
    }
    return 'unknown';
  })();
  const providerTypeFallback = (
    typeof handle.providerType === 'string' && handle.providerType.trim()
      ? handle.providerType.trim().toLowerCase()
      : 'openai'
  ) as ProviderRuntimeProfile['providerType'];
  return {
    runtimeKey,
    providerId: providerIdFallback,
    providerKey,
    providerType: providerTypeFallback,
    providerFamily: handle.providerFamily,
    endpoint: '',
    auth: {
      type: 'apikey',
      value: ''
    }
  };
}

export function emitRequestExecutorVirtualRouterConcurrencyLog(args: {
  sessionId?: string;
  projectPath?: string;
  routeName?: string;
  poolId?: string;
  providerKey?: string;
  model?: string;
  reason?: string;
  stoplessMode?: 'on' | 'off' | 'endless';
  stoplessArmed?: boolean;
  activeInFlight: number;
  maxInFlight: number;
}): void {
  recordVirtualRouterHitRollup({
    routeName: args.routeName,
    poolId: args.poolId,
    providerKey: args.providerKey,
    model: args.model,
    sessionId: args.sessionId,
    projectPath: args.projectPath,
    reason: args.reason,
    stoplessMode: args.stoplessMode,
    stoplessArmed: args.stoplessArmed,
    activeInFlight: args.activeInFlight,
    maxInFlight: args.maxInFlight
  });
}

export function shouldBypassProviderResponseConversion(normalized: PipelineExecutionResult): boolean {
  return typeof normalized.status === 'number' && normalized.status >= 400;
}

export function normalizeStoplessLogMode(value: unknown): StoplessLogMode | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'on' || normalized === 'off' || normalized === 'endless') {
    return normalized;
  }
  return undefined;
}

export function resolveStoplessLogState(metadata: Record<string, unknown>): StoplessLogState {
  const directMode =
    normalizeStoplessLogMode(metadata.reasoningStopMode)
    ?? normalizeStoplessLogMode(metadata.stoplessMode);
  const directArmed =
    typeof metadata.reasoningStopArmed === 'boolean'
      ? metadata.reasoningStopArmed
      : (typeof metadata.stoplessArmed === 'boolean' ? metadata.stoplessArmed : undefined);
  if (!directMode) {
    return {};
  }
  const armed = directArmed ?? true;
  return { mode: directMode, armed };
}

export function isServerToolFollowupRequest(metadata: Record<string, unknown> | undefined): boolean {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return false;
  }
  const rt =
    metadata.__rt && typeof metadata.__rt === 'object' && !Array.isArray(metadata.__rt)
      ? (metadata.__rt as Record<string, unknown>)
      : undefined;
  const raw = rt?.serverToolFollowup;
  return raw === true || (typeof raw === 'string' && raw.trim().toLowerCase() === 'true');
}

export function logProviderRetrySwitchCompact(args: {
  providerSwitchLogState: Map<string, { lastAtMs: number; suppressed: number }>;
  throttleMs: number;
  requestId: string;
  attempt: number;
  maxAttempts: number;
  providerKey?: string;
  nextAttempt: number;
  reason: string;
  backoffMs?: number;
  statusCode?: number;
  errorCode?: string;
  upstreamCode?: string;
  switchAction: 'exclude_and_reroute' | 'retry_same_provider';
  backoffScope?: 'provider' | 'recoverable' | 'attempt';
  decisionLabel?: string;
  stage?: 'provider.runtime_resolve' | 'provider.send';
  runtimeScopeExcludedCount?: number;
}): void {
  const now = Date.now();
  const providerLabel = args.providerKey || 'unknown-provider';
  const compactReason = truncateReason(args.reason, 96);
  const hasStructuredErrorIdentity =
    typeof args.statusCode === 'number'
    || Boolean(args.errorCode)
    || Boolean(args.upstreamCode);
  const dedupeKey = [
    providerLabel,
    args.switchAction,
    typeof args.statusCode === 'number' ? String(args.statusCode) : 'none',
    args.errorCode || 'none',
    args.upstreamCode || 'none',
    hasStructuredErrorIdentity ? 'structured' : compactReason
  ].join('|');
  const prior = args.providerSwitchLogState.get(dedupeKey);
  if (prior && now - prior.lastAtMs < args.throttleMs) {
    prior.suppressed += 1;
    prior.lastAtMs = now;
    args.providerSwitchLogState.set(dedupeKey, prior);
    return;
  }
  if (prior && prior.suppressed > 0 && now - prior.lastAtMs >= args.throttleMs) {
    const aggregateDetails = [
      `provider=${providerLabel}`,
      `switch=${args.switchAction}`,
      ...(typeof args.statusCode === 'number' ? [`status=${args.statusCode}`] : []),
      ...(args.errorCode ? [`code=${args.errorCode}`] : []),
      ...(args.upstreamCode ? [`upstreamCode=${args.upstreamCode}`] : []),
      `suppressed=${prior.suppressed}`,
      `windowMs=${args.throttleMs}`
    ];
    console.warn(`[provider-switch] aggregated ${aggregateDetails.join(' ')}`);
  }
  args.providerSwitchLogState.set(dedupeKey, { lastAtMs: now, suppressed: 0 });
  const boundedAttempt = Math.max(1, Math.min(args.maxAttempts, args.attempt));
  const boundedNextAttempt = Math.max(boundedAttempt, Math.min(args.maxAttempts, args.nextAttempt));
  const retryTag =
    `[provider-switch] req=${args.requestId} attempt=${boundedAttempt}/${args.maxAttempts} -> ` +
    `${boundedNextAttempt}/${args.maxAttempts}`;
  const details = [
    `provider=${providerLabel}`,
    `switch=${args.switchAction}`,
    ...(args.decisionLabel ? [`decision=${args.decisionLabel}`] : []),
    ...(args.backoffScope ? [`backoffScope=${args.backoffScope}`] : []),
    ...(args.stage ? [`stage=${args.stage}`] : []),
    ...(typeof args.statusCode === 'number' ? [`status=${args.statusCode}`] : []),
    ...(args.errorCode ? [`code=${args.errorCode}`] : []),
    ...(args.upstreamCode ? [`upstreamCode=${args.upstreamCode}`] : []),
    ...(typeof args.backoffMs === 'number' ? [`backoff=${Math.max(0, Math.round(args.backoffMs))}ms`] : []),
    ...(typeof args.runtimeScopeExcludedCount === 'number' && args.runtimeScopeExcludedCount > 0
      ? [`runtimeScopeExcluded=${args.runtimeScopeExcludedCount}`]
      : []),
    ...(!hasStructuredErrorIdentity && compactReason ? [`reason=${JSON.stringify(compactReason)}`] : [])
  ];
  console.warn(`${retryTag} ${details.join(' ')}`);
}

export async function releaseProviderTrafficPermit(args: {
  trafficPermit: ProviderTrafficPermit | null;
  trafficGovernor: ProviderTrafficGovernorLike;
  requestId: string;
  providerKey: string;
  runtimeKey?: string;
  attempt: number;
  logStage: (stage: string, requestId: string, details?: Record<string, unknown>) => void;
}): Promise<void> {
  if (!args.trafficPermit) {
    return;
  }
  const releaseStartedAtMs = Date.now();
  args.logStage('provider.traffic.release.start', args.requestId, {
    providerKey: args.providerKey,
    runtimeKey: args.runtimeKey,
    leaseId: args.trafficPermit.leaseId,
    attempt: args.attempt
  });
  try {
    const released = await args.trafficGovernor.release(args.trafficPermit);
    args.logStage('provider.traffic.release.completed', args.requestId, {
      providerKey: args.providerKey,
      runtimeKey: args.runtimeKey,
      leaseId: args.trafficPermit.leaseId,
      released: released.released,
      activeInFlight: released.activeInFlight,
      elapsedMs: Date.now() - releaseStartedAtMs,
      attempt: args.attempt
    });
  } catch (releaseError) {
    args.logStage('provider.traffic.release.error', args.requestId, {
      providerKey: args.providerKey,
      runtimeKey: args.runtimeKey,
      leaseId: args.trafficPermit.leaseId,
      message:
        releaseError instanceof Error
          ? releaseError.message
          : String(releaseError ?? 'Unknown release error'),
      elapsedMs: Date.now() - releaseStartedAtMs,
      attempt: args.attempt
    });
  }
}

export function queueRequestExecutorPayloadContractErrorsample(args: {
  phase: 'provider-request' | 'provider-response';
  requestId: string;
  entryEndpoint?: string;
  providerKey?: string;
  providerId?: string;
  marker: string;
  reason: string;
  observation: unknown;
  onNonBlockingError: (stage: string, error: unknown, details?: Record<string, unknown>) => void;
}): void {
  void writeErrorsampleJson({
    group: 'payload-contract-error',
    kind: `${args.phase}.${args.marker}`,
    payload: {
      kind: 'payload_contract_error',
      timestamp: new Date().toISOString(),
      phase: args.phase,
      marker: args.marker,
      reason: args.reason,
      requestId: args.requestId,
      endpoint: args.entryEndpoint,
      providerKey: args.providerKey,
      providerId: args.providerId,
      observation: args.observation
    }
  }).catch((error) => {
    args.onNonBlockingError('payload_contract_errorsample.write', error, {
      requestId: args.requestId,
      providerKey: args.providerKey,
      marker: args.marker,
      phase: args.phase
    });
  });
}

export function createRequestExecutorPayloadContractErrorsampleWriter(
  onNonBlockingError: (stage: string, error: unknown, details?: Record<string, unknown>) => void
): (args: {
  phase: 'provider-request' | 'provider-response';
  requestId: string;
  entryEndpoint?: string;
  providerKey?: string;
  providerId?: string;
  marker: string;
  reason: string;
  observation: unknown;
}) => void {
  return (args) => {
    queueRequestExecutorPayloadContractErrorsample({
      ...args,
      onNonBlockingError
    });
  };
}
