/**
 * Route Analytics Module
 * 
 * Route statistics and hit tracking extracted from VirtualRouterEngine.
 */

import type { RouterMetadataInput } from '../types.js';
import type { VirtualRouterHitRecord } from '../engine-logging.js';

export interface RouteLastHit {
  timestampMs: number;
  reason?: string;
  requestTokens?: number;
  selectionPenalty?: number;
  stopMessageActive: boolean;
  stopMessageMode?: 'on' | 'off' | 'auto';
  stopMessageRemaining?: number;
}

export interface RouteStats {
  hits: number;
  lastProvider: string;
  lastHit: RouteLastHit;
}

export class RouteAnalytics {
  private routeStats: Map<string, RouteStats> = new Map();

  incrementRouteStat(routeName: string, providerKey: string, hitRecord: VirtualRouterHitRecord): void {
    const nextLastHit: RouteLastHit = {
      timestampMs: hitRecord.timestampMs,
      ...(hitRecord.hitReason ? { reason: hitRecord.hitReason } : {}),
      ...(typeof hitRecord.requestTokens === 'number' ? { requestTokens: hitRecord.requestTokens } : {}),
      ...(typeof hitRecord.selectionPenalty === 'number' ? { selectionPenalty: hitRecord.selectionPenalty } : {}),
      stopMessageActive: hitRecord.stopMessage.active,
      ...(hitRecord.stopMessage.mode !== 'unset' ? { stopMessageMode: hitRecord.stopMessage.mode } : {}),
      ...(hitRecord.stopMessage.remaining >= 0 ? { stopMessageRemaining: hitRecord.stopMessage.remaining } : {})
    };

    if (!this.routeStats.has(routeName)) {
      this.routeStats.set(routeName, { hits: 1, lastProvider: providerKey, lastHit: nextLastHit });
      return;
    }

    const stats = this.routeStats.get(routeName)!;
    stats.hits += 1;
    stats.lastProvider = providerKey;
    stats.lastHit = nextLastHit;
  }

  getRouteStats(routeName: string): RouteStats | undefined {
    return this.routeStats.get(routeName);
  }

  getAllRouteStats(): Map<string, RouteStats> {
    return this.routeStats;
  }

  extractExcludedProviderKeySet(metadata: RouterMetadataInput | undefined): Set<string> {
    if (!metadata) return new Set();
    const raw = (metadata as { excludedProviderKeys?: unknown }).excludedProviderKeys;
    if (!Array.isArray(raw) || raw.length === 0) return new Set();
    const normalized = (raw as string[])
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .filter((value): value is string => Boolean(value));
    return new Set(normalized);
  }
}
