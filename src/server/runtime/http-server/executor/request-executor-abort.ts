export function createClientDisconnectedAbortError(
  reason?: unknown
): Error & { code: string; name: string; retryable?: boolean } {
  const message =
    typeof reason === 'string' && reason.trim()
      ? reason.trim()
      : reason instanceof Error && typeof reason.message === 'string' && reason.message.trim()
        ? reason.message.trim()
        : 'CLIENT_DISCONNECTED';
  return Object.assign(new Error(message), {
    code: 'CLIENT_DISCONNECTED',
    name: 'AbortError',
    retryable: false
  });
}

export function throwIfClientAbortSignalAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return;
  }
  const reason = (signal as { reason?: unknown }).reason;
  throw reason instanceof Error ? reason : createClientDisconnectedAbortError(reason);
}

export async function waitWithClientAbortSignal(
  ms: number,
  signal: AbortSignal | undefined,
  logNonBlockingError: (stage: string, error: unknown, details?: Record<string, unknown>) => void
): Promise<void> {
  throwIfClientAbortSignalAborted(signal);
  if (!(ms > 0)) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      const reason = (signal as { reason?: unknown }).reason;
      reject(reason instanceof Error ? reason : createClientDisconnectedAbortError(reason));
    };
    const cleanup = () => {
      clearTimeout(timer);
      try {
        signal?.removeEventListener?.('abort', onAbort as EventListener);
      } catch (error: unknown) {
        logNonBlockingError('waitWithClientAbortSignal.removeEventListener', error);
      }
    };
    try {
      signal?.addEventListener?.('abort', onAbort as EventListener, { once: true } as AddEventListenerOptions);
    } catch (error: unknown) {
      logNonBlockingError('waitWithClientAbortSignal.addEventListener', error);
    }
  });
}
