import {
  getClientConnectionAbortSignal,
  type ClientConnectionState
} from '../../../utils/client-connection-state.js';

const DEFAULT_SERVERTOOL_FOLLOWUP_TIMEOUT_MS = 900_000;

function parsePositiveTimeoutMs(value: unknown, fallbackMs: number): number {
  const n = typeof value === 'string' ? Number(value.trim()) : typeof value === 'number' ? value : Number.NaN;
  if (!Number.isFinite(n) || n <= 0) {
    return fallbackMs;
  }
  return Math.floor(n);
}

export function resolveServerToolNestedFollowupTimeoutMs(): number {
  return parsePositiveTimeoutMs(
    process.env.ROUTECODEX_SERVERTOOL_FOLLOWUP_TIMEOUT_MS
      ?? process.env.RCC_SERVERTOOL_FOLLOWUP_TIMEOUT_MS
      ?? process.env.LLMSWITCH_SERVERTOOL_FOLLOWUP_TIMEOUT_MS,
    DEFAULT_SERVERTOOL_FOLLOWUP_TIMEOUT_MS
  );
}

export function createServerToolFollowupTimeoutError(args: {
  requestId: string;
  timeoutMs: number;
}): Error & {
  code: string;
  upstreamCode: string;
  status: number;
  statusCode: number;
  retryable: boolean;
  requestExecutorProviderErrorStage: string;
  details: Record<string, unknown>;
} {
  return Object.assign(
    new Error(`[servertool] nested followup timeout after ${args.timeoutMs}ms`),
    {
      code: 'SERVERTOOL_TIMEOUT',
      upstreamCode: 'servertool_followup_timeout',
      status: 504,
      statusCode: 504,
      retryable: false,
      requestExecutorProviderErrorStage: 'provider.followup',
      details: {
        requestId: args.requestId,
        timeoutMs: args.timeoutMs,
        reason: 'nested_followup_timeout',
        requestExecutorProviderErrorStage: 'provider.followup'
      }
    }
  );
}

export async function awaitNestedExecutionWithFailFast<T>(args: {
  promise: Promise<T>;
  abortSignal?: AbortSignal;
  timeoutMs: number;
  requestId: string;
}): Promise<T> {
  const { promise, abortSignal, timeoutMs, requestId } = args;
  if (!(timeoutMs > 0) && !abortSignal) {
    return await promise;
  }

  let timer: NodeJS.Timeout | undefined;
  let abortListener: (() => void) | undefined;
  const cleanup = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (abortSignal && abortListener) {
      try {
        abortSignal.removeEventListener('abort', abortListener);
      } catch {
        // no-op
      }
      abortListener = undefined;
    }
  };

  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        cleanup();
        reject(createServerToolFollowupTimeoutError({ requestId, timeoutMs }));
      }, timeoutMs);
      timer.unref?.();
    }
    if (abortSignal) {
      abortListener = () => {
        cleanup();
        const reason = (abortSignal as { reason?: unknown }).reason;
        reject(reason instanceof Error ? reason : new Error('CLIENT_DISCONNECTED'));
      };
      abortSignal.addEventListener('abort', abortListener, { once: true });
    }
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    cleanup();
  }
}

function isAbortSignalMetadata(
  value: unknown
): value is ClientConnectionState | Record<string, unknown> {
  return !!value && typeof value === 'object';
}

export function getNestedFollowupAbortSignal(metadata: unknown): AbortSignal | undefined {
  return isAbortSignalMetadata(metadata)
    ? getClientConnectionAbortSignal(metadata)
    : undefined;
}

export function throwIfNestedFollowupAborted(metadata: unknown): void {
  const abortSignal = getNestedFollowupAbortSignal(metadata);
  if (!abortSignal?.aborted) {
    return;
  }
  const reason = (abortSignal as { reason?: unknown }).reason;
  throw reason instanceof Error ? reason : new Error('CLIENT_DISCONNECTED');
}
