import {
  resolveClientAbortSignalFromCarrier,
  throwIfClientCarrierAborted
} from './request-executor-client-abort-block.js';

export async function awaitNestedExecutionWithFailFast<T>(args: {
  promise: Promise<T>;
  abortSignal?: AbortSignal;
  abortCarrier?: unknown;
}): Promise<T> {
  const { promise, abortSignal, abortCarrier } = args;
  if (!abortSignal && !abortCarrier) {
    return await promise;
  }

  let abortPoller: NodeJS.Timeout | undefined;
  let abortListener: (() => void) | undefined;
  const cleanup = () => {
    if (abortSignal && abortListener) {
      try {
        abortSignal.removeEventListener('abort', abortListener);
      } catch {
        // no-op
      }
      abortListener = undefined;
    }
    if (abortPoller) {
      clearInterval(abortPoller);
      abortPoller = undefined;
    }
  };

  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    if (abortSignal) {
      abortListener = () => {
        cleanup();
        const reason = (abortSignal as { reason?: unknown }).reason;
        reject(reason instanceof Error ? reason : new Error('CLIENT_DISCONNECTED'));
      };
      abortSignal.addEventListener('abort', abortListener, { once: true });
    }
    if (abortCarrier) {
      abortPoller = setInterval(() => {
        try {
          throwIfClientCarrierAborted(abortCarrier);
        } catch (error) {
          cleanup();
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      }, 100);
    }
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    cleanup();
  }
}

export function getNestedFollowupAbortSignal(metadata: unknown): AbortSignal | undefined {
  return resolveClientAbortSignalFromCarrier(metadata);
}

export function throwIfNestedFollowupAborted(metadata: unknown): void {
  throwIfClientCarrierAborted(metadata);
}
