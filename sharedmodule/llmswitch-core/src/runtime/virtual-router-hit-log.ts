import { loadNativeRouterHotpathBindingForInternalUse } from '../native/router-hotpath/native-router-hotpath.js';
import type {
  ClassificationResult,
  ProviderProfile,
  RoutingFeatures,
  RoutingInstructionMode,
  VirtualRouterContextRoutingConfig
} from '../native/router-hotpath/native-virtual-router-runtime.js';
import type { RoutingInstructionState } from '../native/router-hotpath/native-virtual-router-routing-state.js';

// feature_id: vr.hit_log_projection

type StopMessageRoutingStateView = Pick<
  RoutingInstructionState,
  | 'stopMessageText'
  | 'stopMessageMaxRepeats'
  | 'stopMessageUsed'
  | 'stopMessageUpdatedAt'
  | 'stopMessageLastUsedAt'
  | 'stopMessageStageMode'
>;

type LoggingDeps = {
  providers: Record<string, ProviderProfile>;
  contextRouting: VirtualRouterContextRoutingConfig | undefined;
};

export type StopMessageRuntimeSummary = {
  hasAny: boolean;
  safeText?: string;
  mode: 'on' | 'off' | 'auto' | 'unset';
  maxRepeats: number;
  used: number;
  remaining: number;
  active: boolean;
  updatedAt?: number;
  lastUsedAt?: number;
};

export type VirtualRouterHitRecord = {
  timestampMs: number;
  requestId?: string;
  sessionId?: string;
  routeName: string;
  poolId?: string;
  providerKey: string;
  modelId?: string;
  hitReason?: string;
  continuationScope?: string;
  requestTokens?: number;
  selectionPenalty?: number;
  stopMessage: StopMessageRuntimeSummary;
};

export interface VirtualRouterHitEvent {
  requestId: string;
  timestamp: number;
  entryEndpoint: string;
  routeName: string;
  pool: string;
  providerKey: string;
  runtimeKey?: string;
  providerType?: string;
  modelId?: string;
  reason?: string;
  requestTokens?: number;
  selectionPenalty?: number;
  stopMessageActive?: boolean;
  stopMessageMode?: 'on' | 'off' | 'auto' | 'unset';
  stopMessageRemaining?: number;
}

export type VirtualRouterHitEventMeta = {
  requestId: string;
  entryEndpoint?: string;
};

export type VirtualRouterHitLogOmitField =
  | 'requestId'
  | 'sessionId'
  | 'model'
  | 'reason'
  | 'continuation'
  | 'requestTokens'
  | 'selectionPenalty'
  | 'stopMessage';

export type VirtualRouterHitLogConfig = {
  omit?: VirtualRouterHitLogOmitField[];
};

function invokeNativeVirtualRouterHitLog(exportName: string, args: unknown[]): unknown {
  const binding = loadNativeRouterHotpathBindingForInternalUse() as Record<string, unknown> | null;
  const fn = binding?.[exportName];
  if (typeof fn !== 'function') {
    throw new Error(`[virtual-router-hit-log] native ${exportName} is required but unavailable`);
  }
  try {
    return (fn as (...nativeArgs: unknown[]) => unknown)(...args);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    throw new Error(`[virtual-router-hit-log] native ${exportName} failed: ${reason}`);
  }
}

function parseNativeJson<T>(exportName: string, raw: unknown): T {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error(`[virtual-router-hit-log] native ${exportName} returned empty payload`);
  }
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    throw new Error(`[virtual-router-hit-log] native ${exportName} returned invalid JSON: ${reason}`);
  }
}

function callNativeJson<T>(exportName: string, args: unknown[]): T {
  return parseNativeJson<T>(exportName, invokeNativeVirtualRouterHitLog(exportName, args));
}

function callNativeString(exportName: string, args: unknown[]): string {
  const raw = invokeNativeVirtualRouterHitLog(exportName, args);
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error(`[virtual-router-hit-log] native ${exportName} returned empty string`);
  }
  return raw;
}

export function createVirtualRouterHitRecord(input: {
  requestId?: string;
  sessionId?: string;
  routeName: string;
  poolId?: string;
  providerKey: string;
  modelId?: string;
  hitReason?: string;
  continuationScope?: string;
  routingState?: StopMessageRoutingStateView;
  requestTokens?: number;
  selectionPenalty?: number;
  timestampMs?: number;
}): VirtualRouterHitRecord {
  return callNativeJson<VirtualRouterHitRecord>('createVirtualRouterHitRecordJson', [
    JSON.stringify(input)
  ]);
}

export function toVirtualRouterHitEvent(
  record: VirtualRouterHitRecord,
  meta: VirtualRouterHitEventMeta
): VirtualRouterHitEvent {
  return callNativeJson<VirtualRouterHitEvent>('toVirtualRouterHitEventJson', [
    JSON.stringify(record),
    JSON.stringify(meta)
  ]);
}

export function formatContinuationScope(scope?: string): string | undefined {
  return callNativeJson<string | null>('formatContinuationScopeJson', [scope ?? null]) ?? undefined;
}

export function parseProviderKey(
  providerKey: string
): { providerId: string; keyAlias?: string; modelId?: string } | null {
  return callNativeJson<{ providerId: string; keyAlias?: string; modelId?: string }>(
    'parseVirtualRouterHitProviderKeyJson',
    [providerKey]
  );
}

export function describeTargetProvider(
  providerKey: string,
  fallbackModelId?: string
): { providerLabel: string; resolvedModel?: string } {
  return callNativeJson<{ providerLabel: string; resolvedModel?: string }>(
    'describeTargetProviderJson',
    [providerKey, fallbackModelId ?? null]
  );
}

export function resolveRouteColor(routeName: string): string {
  return callNativeString('resolveRouteColorStr', [routeName]);
}

export function resolveSessionLogColorKey(input?: Record<string, unknown> | null): string | undefined {
  return callNativeJson<string | null>('resolveSessionLogColorKeyJson', [
    JSON.stringify(input ?? null)
  ]) ?? undefined;
}

export function resolveSessionColor(sessionId?: string): string | undefined {
  return callNativeJson<string | null>('resolveSessionColorStr', [sessionId ?? null]) ?? undefined;
}

export function buildHitReason(
  routeUsed: string,
  providerKey: string,
  classification: ClassificationResult,
  features: RoutingFeatures,
  mode: RoutingInstructionMode | undefined,
  deps: LoggingDeps
): string {
  void mode;
  const providerMaxContextTokens = deps.providers[providerKey]?.maxContextTokens;
  return callNativeJson<string>('buildHitReasonJson', [
    routeUsed,
    providerKey,
    classification.reasoning || null,
    Boolean(classification.routeChanged),
    features.estimatedTokens ?? null,
    features.lastAssistantToolLabel ?? null,
    providerMaxContextTokens ?? null,
    deps.contextRouting?.warnRatio ?? null
  ]);
}

export function formatVirtualRouterHit(record: VirtualRouterHitRecord, config?: VirtualRouterHitLogConfig): string {
  return callNativeString('formatVirtualRouterHitJson', [
    JSON.stringify(record),
    config ? JSON.stringify(config) : null
  ]);
}
