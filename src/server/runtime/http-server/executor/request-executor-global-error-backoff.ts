import { waitWithClientAbortSignal } from './request-executor-abort.js';
import { logNonBlockingError as logRequestExecutorNonBlockingError } from './request-executor-error-report.js';

const GLOBAL_ERROR_BACKOFF_BASE_MS = 1_000;
const GLOBAL_ERROR_BACKOFF_MAX_MS = 60_000;

type GlobalErrorBackoffState = {
  consecutiveErrors: number;
  nextAllowedAtMs: number;
};

const globalErrorBackoffState: GlobalErrorBackoffState = {
  consecutiveErrors: 0,
  nextAllowedAtMs: 0
};

let globalErrorBackoffGate: Promise<void> | null = null;

const nowMs = (): number => Date.now();

const computeErrorBackoffDelayMs = (consecutiveErrors: number): number => {
  const exponent = Math.max(0, consecutiveErrors - 1);
  const raw = GLOBAL_ERROR_BACKOFF_BASE_MS * (2 ** exponent);
  return Math.min(GLOBAL_ERROR_BACKOFF_MAX_MS, Math.max(GLOBAL_ERROR_BACKOFF_BASE_MS, raw));
};

export function peekGlobalErrorBackoffWaitMs(): number {
  return Math.max(0, globalErrorBackoffState.nextAllowedAtMs - nowMs());
}

export function resetGlobalErrorBackoff(): void {
  globalErrorBackoffState.consecutiveErrors = 0;
  globalErrorBackoffState.nextAllowedAtMs = 0;
}

export function recordGlobalErrorBackoff(_error?: unknown): number {
  globalErrorBackoffState.consecutiveErrors += 1;
  const delayMs = computeErrorBackoffDelayMs(globalErrorBackoffState.consecutiveErrors);
  globalErrorBackoffState.nextAllowedAtMs = nowMs() + delayMs;
  return delayMs;
}

export async function waitGlobalErrorBackoffWithGate(signal?: AbortSignal): Promise<number> {
  const waitMs = peekGlobalErrorBackoffWaitMs();
  if (waitMs <= 0) {
    return 0;
  }
  if (globalErrorBackoffGate) {
    await globalErrorBackoffGate;
    return waitMs;
  }
  globalErrorBackoffGate = waitWithClientAbortSignal(
    waitMs,
    signal,
    logRequestExecutorNonBlockingError
  ).finally(() => {
    globalErrorBackoffGate = null;
  });
  await globalErrorBackoffGate;
  return waitMs;
}

export function resetGlobalErrorBackoffStateForTests(): void {
  resetGlobalErrorBackoff();
  globalErrorBackoffGate = null;
}

