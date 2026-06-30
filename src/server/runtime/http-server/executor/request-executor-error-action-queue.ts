import {
  waitWithClientAbortSignal
} from './request-executor-abort.js';

export const ERROR_ACTION_QUEUE_FEATURE_ID = 'feature_id: error.backoff_action_queue';

export type ErrorActionCategory =
  | 'global_error'
  | 'session_storm'
  | 'servertool_followup';

export type ErrorActionQueueEvent =
  | {
      type: 'record';
      category: ErrorActionCategory;
      scopeKey: string;
      consecutive: number;
      delayMs: number;
    }
  | {
      type: 'wait_start' | 'wait_end';
      category: ErrorActionCategory;
      scopeKey: string;
      delayMs: number;
    };

type ErrorActionQueueState = {
  consecutive: number;
  updatedAtMs: number;
  nextAllowedAtMs: number;
};

type LogNonBlockingError = (stage: string, error: unknown, details?: Record<string, unknown>) => void;
type ErrorActionQueueHook = (event: ErrorActionQueueEvent) => void;

const ERROR_ACTION_DELAY_SEQUENCE_MS = [1_000, 3_000, 5_000] as const;
const ERROR_ACTION_STATE_TTL_MS = 10 * 60_000;
const ERROR_ACTION_MAX_WAITERS = 64;

const stateByQueueKey = new Map<string, ErrorActionQueueState>();
const gateByQueueKey = new Map<string, Promise<void>>();
const waiterStateByQueueKey = new Map<string, { activeWaiters: number; updatedAtMs: number }>();
const hooks = new Set<ErrorActionQueueHook>();

export function describeErrorActionQueueContract(): {
  featureId: string;
  delaySequenceMs: readonly number[];
  blockingWait: true;
  maxWaiters: number;
  categories: ErrorActionCategory[];
  hookEvents: Array<ErrorActionQueueEvent['type']>;
} {
  return {
    featureId: ERROR_ACTION_QUEUE_FEATURE_ID,
    delaySequenceMs: ERROR_ACTION_DELAY_SEQUENCE_MS,
    blockingWait: true,
    maxWaiters: ERROR_ACTION_MAX_WAITERS,
    categories: [
      'global_error',
      'session_storm',
      'servertool_followup'
    ],
    hookEvents: ['record', 'wait_start', 'wait_end']
  };
}

function nowMs(): number {
  return Date.now();
}

function normalizeScopeKey(scopeKey: string): string {
  return scopeKey.trim() || 'unknown';
}

function buildQueueKey(category: ErrorActionCategory, scopeKey: string): string {
  return `${category}|${normalizeScopeKey(scopeKey)}`;
}

function readBackoffPortScope(metadata?: Record<string, unknown>): string {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return 'unknown-port';
  }
  const candidates = [
    metadata.routecodexRoutingPolicyGroup,
    metadata.routecodexPort,
    metadata.routecodexLocalPort,
    metadata.routecodexPortMode
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return String(Math.floor(candidate));
    }
  }
  return 'unknown-port';
}

export function resolveProviderTransportBackoffScopeKey(args: {
  providerTransportBackoffKey?: string;
  portScope?: string;
  metadata?: Record<string, unknown>;
  providerKey?: string;
}): string {
  if (typeof args.providerTransportBackoffKey === 'string' && args.providerTransportBackoffKey.trim()) {
    return args.providerTransportBackoffKey.trim();
  }
  const portScope =
    typeof args.portScope === 'string' && args.portScope.trim()
      ? args.portScope.trim()
      : readBackoffPortScope(args.metadata);
  const providerKey =
    typeof args.providerKey === 'string' && args.providerKey.trim()
      ? args.providerKey.trim()
      : 'unknown-provider';
  return `${normalizeScopeKey(portScope)}|${normalizeScopeKey(providerKey)}|transport`;
}

export function resolveProviderSwitchBackoffScopeKey(args: {
  providerSwitchBackoffKey?: string;
  portScope?: string;
  metadata?: Record<string, unknown>;
  routeName?: string;
}): string {
  if (typeof args.providerSwitchBackoffKey === 'string' && args.providerSwitchBackoffKey.trim()) {
    return args.providerSwitchBackoffKey.trim();
  }
  const portScope =
    typeof args.portScope === 'string' && args.portScope.trim()
      ? args.portScope.trim()
      : readBackoffPortScope(args.metadata);
  const routeName =
    typeof args.routeName === 'string' && args.routeName.trim()
      ? args.routeName.trim()
      : 'unknown-route';
  return `${normalizeScopeKey(portScope)}|${normalizeScopeKey(routeName)}|provider-switch`;
}

export function recordProviderTransportBackoff(args: {
  providerKey?: string;
  portScope?: string;
  metadata?: Record<string, unknown>;
  providerTransportBackoffKey?: string;
}): number {
  return recordErrorActionBackoff({
    category: 'global_error',
    scopeKey: resolveProviderTransportBackoffScopeKey(args)
  });
}

export function recordProviderSwitchBackoff(args: {
  routeName?: string;
  portScope?: string;
  metadata?: Record<string, unknown>;
  providerSwitchBackoffKey?: string;
}): number {
  return recordErrorActionBackoff({
    category: 'global_error',
    scopeKey: resolveProviderSwitchBackoffScopeKey(args)
  });
}

export async function waitProviderTransportBackoffWithGate(args: {
  providerKey?: string;
  portScope?: string;
  metadata?: Record<string, unknown>;
  providerTransportBackoffKey?: string;
  ms?: number;
  signal?: AbortSignal;
  logNonBlockingError?: LogNonBlockingError;
}): Promise<number> {
  return waitErrorActionBackoffWithGate({
    category: 'global_error',
    scopeKey: resolveProviderTransportBackoffScopeKey(args),
    ms: args.ms,
    signal: args.signal,
    logNonBlockingError: args.logNonBlockingError
  });
}

export async function waitProviderSwitchBackoffWithGate(args: {
  routeName?: string;
  portScope?: string;
  metadata?: Record<string, unknown>;
  providerSwitchBackoffKey?: string;
  ms?: number;
  signal?: AbortSignal;
  logNonBlockingError?: LogNonBlockingError;
}): Promise<number> {
  return waitErrorActionBackoffWithGate({
    category: 'global_error',
    scopeKey: resolveProviderSwitchBackoffScopeKey(args),
    ms: args.ms,
    signal: args.signal,
    logNonBlockingError: args.logNonBlockingError
  });
}

function emitHook(event: ErrorActionQueueEvent): void {
  for (const hook of hooks) {
    hook(event);
  }
}

function pruneExpired(currentMs = nowMs()): void {
  for (const [key, state] of stateByQueueKey.entries()) {
    if (currentMs - state.updatedAtMs >= ERROR_ACTION_STATE_TTL_MS) {
      stateByQueueKey.delete(key);
    }
  }
  for (const [key, state] of waiterStateByQueueKey.entries()) {
    if (state.activeWaiters <= 0 || currentMs - state.updatedAtMs >= ERROR_ACTION_STATE_TTL_MS) {
      waiterStateByQueueKey.delete(key);
    }
  }
}

export function computeErrorActionBackoffDelayMs(consecutive: number): number {
  const step = Math.max(1, Math.floor(Number.isFinite(consecutive) ? consecutive : 1));
  return ERROR_ACTION_DELAY_SEQUENCE_MS[(step - 1) % ERROR_ACTION_DELAY_SEQUENCE_MS.length] ?? 1_000;
}

export function recordErrorActionBackoff(args: {
  category: ErrorActionCategory;
  scopeKey: string;
}): number {
  const currentMs = nowMs();
  pruneExpired(currentMs);
  const queueKey = buildQueueKey(args.category, args.scopeKey);
  const previous = stateByQueueKey.get(queueKey);
  const consecutive =
    previous && currentMs - previous.updatedAtMs < ERROR_ACTION_STATE_TTL_MS
      ? previous.consecutive + 1
      : 1;
  const delayMs = computeErrorActionBackoffDelayMs(consecutive);
  const scopeKey = normalizeScopeKey(args.scopeKey);
  stateByQueueKey.set(queueKey, {
    consecutive,
    updatedAtMs: currentMs,
    nextAllowedAtMs: currentMs + delayMs
  });
  emitHook({
    type: 'record',
    category: args.category,
    scopeKey,
    consecutive,
    delayMs
  });
  return delayMs;
}

export function peekErrorActionBackoffWaitMs(args: {
  category: ErrorActionCategory;
  scopeKey: string;
}): number {
  const currentMs = nowMs();
  const queueKey = buildQueueKey(args.category, args.scopeKey);
  const state = stateByQueueKey.get(queueKey);
  if (!state) {
    return 0;
  }
  if (currentMs - state.updatedAtMs >= ERROR_ACTION_STATE_TTL_MS) {
    stateByQueueKey.delete(queueKey);
    return 0;
  }
  return Math.max(0, state.nextAllowedAtMs - currentMs);
}

export function resetErrorActionBackoff(args: {
  category?: ErrorActionCategory;
  scopeKey?: string;
} = {}): void {
  if (!args.category && !args.scopeKey) {
    stateByQueueKey.clear();
    gateByQueueKey.clear();
    waiterStateByQueueKey.clear();
    return;
  }
  const scope = typeof args.scopeKey === 'string' ? normalizeScopeKey(args.scopeKey) : undefined;
  for (const key of stateByQueueKey.keys()) {
    const matchesCategory = !args.category || key.startsWith(`${args.category}|`);
    const matchesScope = !scope || key.endsWith(`|${scope}`);
    if (matchesCategory && matchesScope) {
      stateByQueueKey.delete(key);
    }
  }
}

export function resetErrorActionBackoffByScopePrefix(args: {
  category?: ErrorActionCategory;
  scopePrefix: string;
}): void {
  const prefix = normalizeScopeKey(args.scopePrefix);
  if (!prefix) {
    return;
  }
  for (const key of stateByQueueKey.keys()) {
    const matchesCategory = !args.category || key.startsWith(`${args.category}|`);
    const scopePart = key.slice(key.indexOf('|') + 1);
    if (matchesCategory && scopePart.startsWith(prefix)) {
      stateByQueueKey.delete(key);
    }
  }
}

function acquireWaiterSlot(queueKey: string): void {
  const currentMs = nowMs();
  pruneExpired(currentMs);
  const current = waiterStateByQueueKey.get(queueKey);
  const activeWaiters = (current?.activeWaiters ?? 0) + 1;
  if (activeWaiters > ERROR_ACTION_MAX_WAITERS) {
    throw Object.assign(
      new Error(`error action waiters overloaded for key ${queueKey}`),
      {
        statusCode: 429,
        code: 'PROVIDER_TRAFFIC_SATURATED',
        retryable: true,
        details: {
          reason: 'error_action_waiter_overload',
          actionQueueKey: queueKey,
          activeWaiters: current?.activeWaiters ?? 0,
          maxWaiters: ERROR_ACTION_MAX_WAITERS
        }
      }
    );
  }
  waiterStateByQueueKey.set(queueKey, {
    activeWaiters,
    updatedAtMs: currentMs
  });
}

function releaseWaiterSlot(queueKey: string): void {
  const current = waiterStateByQueueKey.get(queueKey);
  if (!current) {
    return;
  }
  const activeWaiters = Math.max(0, current.activeWaiters - 1);
  if (activeWaiters === 0) {
    waiterStateByQueueKey.delete(queueKey);
    return;
  }
  waiterStateByQueueKey.set(queueKey, {
    activeWaiters,
    updatedAtMs: nowMs()
  });
}

export async function waitErrorActionBackoffWithGate(args: {
  category: ErrorActionCategory;
  scopeKey: string;
  ms?: number;
  signal?: AbortSignal;
  logNonBlockingError?: LogNonBlockingError;
}): Promise<number> {
  const waitMs = typeof args.ms === 'number' && Number.isFinite(args.ms) && args.ms > 0
    ? Math.floor(args.ms)
    : peekErrorActionBackoffWaitMs(args);
  if (waitMs <= 0) {
    return 0;
  }
  const scopeKey = normalizeScopeKey(args.scopeKey);
  const queueKey = buildQueueKey(args.category, scopeKey);
  const logNonBlockingError = args.logNonBlockingError ?? (() => undefined);
  acquireWaiterSlot(queueKey);
  const previous = gateByQueueKey.get(queueKey) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  gateByQueueKey.set(queueKey, current);
  try {
    await previous.catch((error: unknown) => {
      logNonBlockingError('waitErrorActionBackoffWithGate.previous', error, { key: queueKey });
    });
    emitHook({ type: 'wait_start', category: args.category, scopeKey, delayMs: waitMs });
    await waitWithClientAbortSignal(waitMs, args.signal, logNonBlockingError);
    emitHook({ type: 'wait_end', category: args.category, scopeKey, delayMs: waitMs });
    return waitMs;
  } finally {
    release();
    if (gateByQueueKey.get(queueKey) === current) {
      gateByQueueKey.delete(queueKey);
    }
    releaseWaiterSlot(queueKey);
  }
}

export function registerErrorActionQueueHook(hook: ErrorActionQueueHook): () => void {
  hooks.add(hook);
  return () => {
    hooks.delete(hook);
  };
}

export function peekErrorActionBackoffConsecutiveForTests(args: {
  category: ErrorActionCategory;
  scopeKey: string;
}): number {
  return stateByQueueKey.get(buildQueueKey(args.category, args.scopeKey))?.consecutive ?? 0;
}

export function peekErrorActionWaitersForTests(args: {
  category: ErrorActionCategory;
  scopeKey: string;
}): number {
  return waiterStateByQueueKey.get(buildQueueKey(args.category, args.scopeKey))?.activeWaiters ?? 0;
}

export function resetErrorActionQueueStateForTests(): void {
  stateByQueueKey.clear();
  gateByQueueKey.clear();
  waiterStateByQueueKey.clear();
  hooks.clear();
}
