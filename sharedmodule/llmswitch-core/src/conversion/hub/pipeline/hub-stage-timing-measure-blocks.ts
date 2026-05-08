import { logHubStageTiming } from "./hub-stage-timing.js";

export async function measureHubStageExecution<T>(
  requestId: string,
  stage: string,
  fn: () => Promise<T> | T,
  options?: {
    startDetails?: Record<string, unknown>;
    mapCompletedDetails?: (value: T) => Record<string, unknown> | undefined;
    mapErrorDetails?: (error: unknown) => Record<string, unknown> | undefined;
  },
): Promise<T> {
  const startedAt = Date.now();
  logHubStageTiming(requestId, stage, "start", options?.startDetails);
  try {
    const value = await fn();
    const elapsedMs = Math.max(0, Date.now() - startedAt);
    logHubStageTiming(requestId, stage, "completed", {
      elapsedMs,
      ...(options?.mapCompletedDetails?.(value) ?? {}),
    });
    return value;
  } catch (error) {
    const elapsedMs = Math.max(0, Date.now() - startedAt);
    const mapped = options?.mapErrorDetails?.(error);
    const message =
      error instanceof Error ? error.message : String(error ?? "unknown");
    logHubStageTiming(requestId, stage, "error", mapped ?? {
      elapsedMs,
      message,
    });
    throw error;
  }
}
