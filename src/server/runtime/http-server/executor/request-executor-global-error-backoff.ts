import { waitWithClientAbortSignal } from './request-executor-abort.js';
import { logNonBlockingError as logRequestExecutorNonBlockingError } from './request-executor-error-report.js';

const ERROR_BACKOFF_BASE_MS = 1_000;
const ERROR_BACKOFF_MAX_MS = 60_000;

type ErrorBackoffState = {
  consecutiveErrors: number;
  nextAllowedAtMs: number;
};

const scopedBackoffState = new Map<string, ErrorBackoffState>();
const scopedBackoffGate = new Map<string, Promise<void>>();

const nowMs = (): number => Date.now();

const computeErrorBackoffDelayMs = (consecutiveErrors: number): number => {
  const exponent = Math.max(0, consecutiveErrors - 1);
  const raw = ERROR_BACKOFF_BASE_MS * (2 ** exponent);
  return Math.min(ERROR_BACKOFF_MAX_MS, Math.max(ERROR_BACKOFF_BASE_MS, raw));
};

function readScopeState(scopeKey: string): ErrorBackoffState {
  const existing = scopedBackoffState.get(scopeKey);
  if (existing) {
    return existing;
  }
  const created: ErrorBackoffState = { consecutiveErrors: 0, nextAllowedAtMs: 0 };
  scopedBackoffState.set(scopeKey, created);
  return created;
}

export function peekScopedErrorBackoffWaitMs(scopeKey: string): number {
  if (!scopeKey) return 0;
  const state = scopedBackoffState.get(scopeKey);
  if (!state) return 0;
  return Math.max(0, state.nextAllowedAtMs - nowMs());
}

export function resetScopedErrorBackoff(scopeKey: string): void {
  if (!scopeKey) return;
  scopedBackoffState.delete(scopeKey);
}

export function resetScopedErrorBackoffByProvider(prefixKey: string): void {
  if (!prefixKey) return;
  for (const key of scopedBackoffState.keys()) {
    if (key.startsWith(prefixKey)) {
      scopedBackoffState.delete(key);
    }
  }
}

export function recordScopedErrorBackoff(scopeKey: string): number {
  if (!scopeKey) return 0;
  const state = readScopeState(scopeKey);
  state.consecutiveErrors += 1;
  const delayMs = computeErrorBackoffDelayMs(state.consecutiveErrors);
  state.nextAllowedAtMs = nowMs() + delayMs;
  return delayMs;
}

export async function waitScopedErrorBackoffWithGate(scopeKey: string, signal?: AbortSignal): Promise<number> {
  const waitMs = peekScopedErrorBackoffWaitMs(scopeKey);
  if (!scopeKey || waitMs <= 0) {
    return 0;
  }
  const existing = scopedBackoffGate.get(scopeKey);
  if (existing) {
    await existing;
    return waitMs;
  }
  const gate = waitWithClientAbortSignal(waitMs, signal, logRequestExecutorNonBlockingError)
    .finally(() => {
      scopedBackoffGate.delete(scopeKey);
    });
  scopedBackoffGate.set(scopeKey, gate);
  await gate;
  return waitMs;
}

export function resetGlobalErrorBackoffStateForTests(): void {
  scopedBackoffState.clear();
  scopedBackoffGate.clear();
}
