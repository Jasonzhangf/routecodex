import path from 'node:path';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const nativeBinding = nodeRequire(
  path.resolve(process.cwd(), 'sharedmodule/llmswitch-core/dist/native/router_hotpath_napi.node')
) as Record<string, unknown>;

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

export type VirtualRouterHitEvent = {
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

function nativeFn(name: string): (...args: unknown[]) => unknown {
  const fn = nativeBinding[name];
  if (typeof fn !== 'function') {
    throw new Error(`${name} native export is required`);
  }
  return fn as (...args: unknown[]) => unknown;
}

function throwNativeError(raw: unknown): never {
  if (typeof raw === 'object' && raw !== null && 'message' in raw) {
    throw new Error(String((raw as { message: unknown }).message));
  }
  throw new Error(String(raw ?? 'unknown native error'));
}

function parseNativeJson<T>(raw: unknown): T {
  if (typeof raw === 'object' && raw !== null && 'message' in raw) {
    throwNativeError(raw);
  }
  if (typeof raw === 'string' && raw.startsWith('Error: ')) {
    throwNativeError(raw);
  }
  return JSON.parse(String(raw)) as T;
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
  routingState?: Record<string, unknown>;
  requestTokens?: number;
  selectionPenalty?: number;
  timestampMs?: number;
}): VirtualRouterHitRecord {
  return parseNativeJson<VirtualRouterHitRecord>(
    nativeFn('createVirtualRouterHitRecordJson')(JSON.stringify(input))
  );
}

export function toVirtualRouterHitEvent(
  record: VirtualRouterHitRecord,
  meta: { requestId: string; entryEndpoint?: string }
): VirtualRouterHitEvent {
  return parseNativeJson<VirtualRouterHitEvent>(
    nativeFn('toVirtualRouterHitEventJson')(JSON.stringify(record), JSON.stringify(meta))
  );
}

export function formatVirtualRouterHit(record: VirtualRouterHitRecord, config?: VirtualRouterHitLogConfig): string {
  const raw = nativeFn('formatVirtualRouterHitJson')(
    JSON.stringify(record),
    config ? JSON.stringify(config) : null
  );
  if (typeof raw !== 'string' || raw.length === 0) {
    throwNativeError(raw);
  }
  return raw;
}

export function resolveSessionLogColorKey(input?: Record<string, unknown> | null): string | undefined {
  return parseNativeJson<string | null>(
    nativeFn('resolveSessionLogColorKeyJson')(JSON.stringify(input ?? null))
  ) ?? undefined;
}

export function resolveSessionColor(sessionId?: string): string | undefined {
  return parseNativeJson<string | null>(
    nativeFn('resolveSessionColorStr')(sessionId ?? null)
  ) ?? undefined;
}
