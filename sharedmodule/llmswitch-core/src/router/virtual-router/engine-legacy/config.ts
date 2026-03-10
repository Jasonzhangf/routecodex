import type { ProviderQuotaView } from '../types.js';
import type { VirtualRouterConfig, VirtualRouterHealthStore } from '../types.js';
import type { RoutingInstructionStateStoreLike } from '../engine/routing-state/store.js';
import type { VirtualRouterEngine } from '../engine-legacy.js';
import { RouteLoadBalancer } from '../load-balancer.js';
import { StickySessionManager } from '../engine/sticky-session-manager.js';
import { RoutingClassifier } from '../classifier.js';
import {
  loadRoutingInstructionStateSync,
  saveRoutingInstructionStateAsync,
  saveRoutingInstructionStateSync
} from '../sticky-session-store.js';
import { resolveAntigravityAliasReuseCooldownMs, hydrateAntigravityAliasLeaseStoreIfNeeded } from '../engine/antigravity/alias-lease.js';
import { routeHasTargets, hasPrimaryPool } from './route-utils.js';
import { DEFAULT_ROUTE, VirtualRouterError, VirtualRouterErrorCode } from '../types.js';

export function updateDeps(
  engine: VirtualRouterEngine,
  deps: {
    healthStore?: VirtualRouterHealthStore | null;
    routingStateStore?: RoutingInstructionStateStoreLike | null;
    quotaView?: ProviderQuotaView | null;
  }
): void {
  if (!deps || typeof deps !== 'object') {
    return;
  }
  if ('healthStore' in deps) {
    engine.healthStore = deps.healthStore ?? undefined;
    engine.cooldownManager.updateDeps({ healthStore: engine.healthStore });
  }
  if ('routingStateStore' in deps) {
    engine.routingStateStore =
      deps.routingStateStore ??
      ({
        loadSync: loadRoutingInstructionStateSync,
        saveAsync: saveRoutingInstructionStateAsync,
        saveSync: saveRoutingInstructionStateSync
      } satisfies RoutingInstructionStateStoreLike);
    // Routing state store changes require clearing in-memory cache to avoid stale reads.
    engine.routingInstructionState.clear();
  }
  if ('quotaView' in deps) {
    const prevQuotaEnabled = Boolean(engine.quotaView);
    engine.quotaView = deps.quotaView ?? undefined;
    engine.cooldownManager.updateDeps({ quotaView: engine.quotaView });
    const nextQuotaEnabled = Boolean(engine.quotaView);
    // When quotaView is enabled, health/cooldown decisions must be driven by quotaView only.
    // - Enabling quotaView: clear any legacy router-local cooldown TTLs immediately.
    // - Disabling quotaView: reload legacy cooldown state from health snapshots.
    if (!prevQuotaEnabled && nextQuotaEnabled) {
      engine.cooldownManager.clearAllCooldowns();
    } else if (prevQuotaEnabled && !nextQuotaEnabled) {
      engine.cooldownManager.clearAllCooldowns();
      engine.restoreHealthFromStore();
    }
  }
}

export function initialize(engine: VirtualRouterEngine, config: VirtualRouterConfig): void {
  validateConfig(engine, config);
  engine.routing = config.routing;
  engine.providerRegistry.load(config.providers);
  engine.healthManager.configure(config.health);
  engine.healthConfig = config.health ?? null;
  engine.healthManager.registerProviders(Object.keys(config.providers));
  engine.cooldownManager.clearAllCooldowns();
  engine.restoreHealthFromStore();
  engine.loadBalancer = new RouteLoadBalancer(config.loadBalancing);
  const aliasReuseCooldownMs = resolveAntigravityAliasReuseCooldownMs(config);
  engine.stickySessionManager = new StickySessionManager(aliasReuseCooldownMs);
  hydrateAntigravityAliasLeaseStoreIfNeeded({
    force: true,
    leaseStore: engine.stickySessionManager.getAllStores().aliasLeaseStore,
    persistence: engine.antigravityLeasePersistence,
    aliasReuseCooldownMs: engine.stickySessionManager.getAliasReuseCooldownMs()
  });
  engine.classifier = new RoutingClassifier(config.classifier);
  engine.contextRouting = config.contextRouting ?? { warnRatio: 0.9, hardLimit: false };
  engine.contextAdvisor.configure(engine.contextRouting);
  engine.webSearchForce = config.webSearch?.force === true;
  engine.routeAnalytics.getAllRouteStats().clear();
  for (const routeName of Object.keys(engine.routing)) {
    engine.routeAnalytics.getRouteStats(routeName) ||
      engine.routeAnalytics.incrementRouteStat(routeName, '', {
        timestampMs: Date.now(),
        stopMessage: { active: false }
      } as any);
  }
}

export function validateConfig(engine: VirtualRouterEngine, config: VirtualRouterConfig): void {
  if (!config.routing || typeof config.routing !== 'object') {
    throw new VirtualRouterError('routing configuration is required', VirtualRouterErrorCode.CONFIG_ERROR);
  }
  if (!config.providers || Object.keys(config.providers).length === 0) {
    throw new VirtualRouterError('providers configuration is required', VirtualRouterErrorCode.CONFIG_ERROR);
  }
  const defaultPools = config.routing[DEFAULT_ROUTE];
  if (!routeHasTargets(engine, defaultPools)) {
    throw new VirtualRouterError(
      'default route must be configured with at least one provider',
      VirtualRouterErrorCode.CONFIG_ERROR
    );
  }
  if (!hasPrimaryPool(engine, defaultPools)) {
    throw new VirtualRouterError(
      'default route must define at least one non-backup pool',
      VirtualRouterErrorCode.CONFIG_ERROR
    );
  }
  const providerKeys = new Set(Object.keys(config.providers));
  for (const [routeName, pools] of Object.entries(config.routing)) {
    if (!routeHasTargets(engine, pools)) {
      if (routeName === DEFAULT_ROUTE) {
        throw new VirtualRouterError('default route cannot be empty', VirtualRouterErrorCode.CONFIG_ERROR);
      }
      continue;
    }
    for (const pool of pools) {
      if (!Array.isArray(pool.targets) || !pool.targets.length) {
        continue;
      }
      for (const providerKey of pool.targets) {
        if (!providerKeys.has(providerKey)) {
          throw new VirtualRouterError(
            `Route ${routeName} references unknown provider ${providerKey}`,
            VirtualRouterErrorCode.CONFIG_ERROR
          );
        }
      }
    }
  }
}
