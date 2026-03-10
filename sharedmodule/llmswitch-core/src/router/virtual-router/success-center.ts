import type { ProviderSuccessEvent } from './types.js';

type ProviderSuccessListener = (event: ProviderSuccessEvent) => void;

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
      } catch {
        // Listener failures should not break propagation
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

