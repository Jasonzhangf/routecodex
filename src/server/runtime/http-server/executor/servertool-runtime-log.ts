const NON_BLOCKING_LOG_THROTTLE_MS = 60_000;
const nonBlockingLogState = new Map<string, number>();

export function formatExecutorRuntimeLogError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function logExecutorRuntimeNonBlockingWarning(args: {
  namespace: string;
  stage: string;
  error: unknown;
  details?: Record<string, unknown>;
  throttleKey?: string;
}): void {
  const formattedError = formatExecutorRuntimeLogError(args.error);
  const throttleKey = args.throttleKey || `${args.namespace}:${args.stage}:${formattedError}`;
  const now = Date.now();
  const last = nonBlockingLogState.get(throttleKey) ?? 0;
  if (now - last < NON_BLOCKING_LOG_THROTTLE_MS) {
    return;
  }
  nonBlockingLogState.set(throttleKey, now);
  try {
    const detailSuffix = args.details && Object.keys(args.details).length > 0
      ? ` details=${JSON.stringify(args.details)}`
      : '';
    console.warn(
      `[${args.namespace}] ${args.stage} failed (non-blocking): ${formattedError}${detailSuffix}`
    );
  } catch {
    // Never throw from non-blocking logging.
  }
}
