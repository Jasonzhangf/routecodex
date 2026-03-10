import type { ProviderErrorEvent } from './types.js';

type ProviderErrorListener = (event: ProviderErrorEvent) => void;

export class ProviderErrorCenter {
  private readonly listeners: Set<ProviderErrorListener> = new Set();

  subscribe(listener: ProviderErrorListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: ProviderErrorEvent): ProviderErrorEvent {
    const enriched = this.normalize(event);
    for (const listener of this.listeners) {
      try {
        listener(enriched);
      } catch {
        // Listener failures should not break propagation
      }
    }
    return enriched;
  }

  private normalize(event: ProviderErrorEvent): ProviderErrorEvent {
    const timestamp = typeof event.timestamp === 'number' ? event.timestamp : Date.now();
    const code = event.code?.toString() || 'ERR_UNKNOWN';
    const message = event.message || code;
    const stage = event.stage || 'unknown';
    const runtime = event.runtime || ({} as any);
    return {
      code,
      message,
      stage,
      status: event.status,
      recoverable: event.recoverable,
      runtime,
      timestamp,
      details: event.details
    };
  }
}

export const providerErrorCenter = new ProviderErrorCenter();
