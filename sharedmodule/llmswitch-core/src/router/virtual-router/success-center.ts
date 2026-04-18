import type { ProviderSuccessEvent } from './types.js';

type ProviderSuccessListener = (event: ProviderSuccessEvent) => void;
const NON_BLOCKING_WARN_THROTTLE_MS = 60_000;
const nonBlockingWarnByStage = new Map<string, number>();

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || `${error.name}: ${error.message}`;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function shouldLogNonBlockingStage(stage: string): boolean {
  const now = Date.now();
  const lastAt = nonBlockingWarnByStage.get(stage) ?? 0;
  if (now - lastAt < NON_BLOCKING_WARN_THROTTLE_MS) {
    return false;
  }
  nonBlockingWarnByStage.set(stage, now);
  return true;
}

function logSuccessCenterNonBlockingError(
  stage: string,
  operation: string,
  error: unknown,
  details?: Record<string, unknown>
): void {
  if (!shouldLogNonBlockingStage(stage)) {
    return;
  }
  try {
    const suffix = details && Object.keys(details).length > 0 ? ` details=${JSON.stringify(details)}` : '';
    console.warn(
      `[success-center] stage=${stage} operation=${operation} failed (non-blocking): ${formatUnknownError(error)}${suffix}`
    );
  } catch {
    void 0;
  }
}

export class ProviderSuccessCenter {
  private readonly listeners: Set<ProviderSuccessListener> = new Set();

  subscribe(listener: ProviderSuccessListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: ProviderSuccessEvent): ProviderSuccessEvent {
    const enriched = this.normalize(event);
    for (const listener of this.listeners) {
      try {
        listener(enriched);
      } catch (error) {
        logSuccessCenterNonBlockingError('listener_dispatch', 'provider_success_listener', error, {
          providerKey: enriched.runtime?.providerKey,
          requestId: enriched.runtime?.requestId
        });
      }
    }
    return enriched;
  }

  private normalize(event: ProviderSuccessEvent): ProviderSuccessEvent {
    const timestamp = typeof event.timestamp === 'number' ? event.timestamp : Date.now();
    const runtime = event.runtime || ({} as any);
    return {
      runtime,
      timestamp,
      metadata: event.metadata,
      details: event.details
    };
  }
}

export const providerSuccessCenter = new ProviderSuccessCenter();
