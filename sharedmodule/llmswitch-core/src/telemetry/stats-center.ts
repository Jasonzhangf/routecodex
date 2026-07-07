import { resolveRccPath } from "../runtime/user-data-paths.js";

export interface VirtualRouterHitEvent {
  requestId: string;
  timestamp: number;
  entryEndpoint: string;
  routeName: string;
  pool: string;
  providerKey: string;
  runtimeKey?: string;
  providerType?: string;
  modelId?: string;
  reason?: string;
  requestTokens?: number;
  selectionPenalty?: number;
  stopMessageActive?: boolean;
  stopMessageMode?: "on" | "off" | "auto" | "unset";
  stopMessageRemaining?: number;
}

interface ProviderUsageEvent {
  requestId: string;
  timestamp: number;
  providerKey: string;
  runtimeKey?: string;
  providerType: string;
  modelId?: string;
  routeName?: string;
  entryEndpoint?: string;
  success: boolean;
  latencyMs: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

interface StatsSnapshot {
  router: {
    global: Record<string, unknown>;
    byEntryEndpoint: Record<string, Record<string, unknown>>;
  };
  providers: {
    global: Record<string, unknown>;
    byProviderKey: Record<string, Record<string, unknown>>;
    byRoute: Record<string, Record<string, unknown>>;
    byEntryEndpoint: Record<string, Record<string, unknown>>;
  };
}

interface StatsCenter {
  recordVirtualRouterHit(ev: VirtualRouterHitEvent): void;
  recordProviderUsage(ev: ProviderUsageEvent): void;
  getSnapshot(): StatsSnapshot;
  flushToDisk(): Promise<void>;
  reset(): void;
}

class NoopStatsCenter implements StatsCenter {
  recordVirtualRouterHit(): void { /* noop */ }
  recordProviderUsage(): void { /* noop */ }
  getSnapshot(): StatsSnapshot { return { router: { global: {}, byEntryEndpoint: {} }, providers: { global: {}, byProviderKey: {}, byRoute: {}, byEntryEndpoint: {} } }; }
  async flushToDisk(): Promise<void> { /* noop */ }
  reset(): void { /* noop */ }
}

var _instance = new NoopStatsCenter();

export function getStatsCenter(): StatsCenter {
  return _instance;
}
