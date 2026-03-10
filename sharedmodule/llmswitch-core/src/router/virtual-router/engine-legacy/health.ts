import type {
  ProviderErrorEvent,
  ProviderFailureEvent,
  ProviderHealthConfig,
  ProviderSuccessEvent,
  VirtualRouterHealthSnapshot
} from '../types.js';
import type { VirtualRouterEngine } from '../engine-legacy.js';
import {
  applyAntigravityRiskPolicyImpl,
  applyQuotaDepletedImpl,
  applyQuotaRecoveryImpl,
  applySeriesCooldownImpl,
  handleProviderFailureImpl,
  mapProviderErrorImpl
} from '../engine/health/index.js';
import { recordAntigravitySessionLease } from '../engine/antigravity/alias-lease.js';

export function providerHealthConfig(engine: VirtualRouterEngine): Required<ProviderHealthConfig> {
  return engine.healthManager.getConfig();
}

export function markProviderCooldown(
  engine: VirtualRouterEngine,
  providerKey: string,
  cooldownMs: number | undefined
): void {
  engine.cooldownManager.markProviderCooldown(providerKey, cooldownMs);
}

export function clearProviderCooldown(engine: VirtualRouterEngine, providerKey: string): void {
  engine.cooldownManager.clearProviderCooldown(providerKey);
}

export function isProviderCoolingDown(engine: VirtualRouterEngine, providerKey: string): boolean {
  return engine.cooldownManager.isProviderCoolingDown(providerKey);
}

export function getProviderCooldownRemainingMs(engine: VirtualRouterEngine, providerKey: string): number {
  if (!providerKey) {
    return 0;
  }
  const expiry = engine.cooldownManager.getCooldownMap().get(providerKey);
  if (!expiry || !Number.isFinite(expiry)) {
    return 0;
  }
  const remaining = Math.floor(expiry - Date.now());
  return remaining > 0 ? remaining : 0;
}

export function restoreHealthFromStore(engine: VirtualRouterEngine): void {
  engine.cooldownManager.restoreHealthFromStore();
}

export function buildHealthSnapshot(engine: VirtualRouterEngine): VirtualRouterHealthSnapshot {
  const providers = engine.healthManager.getSnapshot();
  const cooldownSnapshot = engine.cooldownManager.buildHealthSnapshot();
  return { providers, cooldowns: cooldownSnapshot.cooldowns };
}

export function persistHealthSnapshot(engine: VirtualRouterEngine): void {
  engine.cooldownManager.persistHealthSnapshot();
}

export function handleProviderFailure(engine: VirtualRouterEngine, event: ProviderFailureEvent): void {
  handleProviderFailureImpl(
    event,
    engine.healthManager,
    providerHealthConfig(engine),
    (key, ttl) => markProviderCooldown(engine, key, ttl)
  );
}

export function handleProviderError(engine: VirtualRouterEngine, event: ProviderErrorEvent): void {
  if (engine.healthStore && typeof engine.healthStore.recordProviderError === 'function') {
    try {
      engine.healthStore.recordProviderError(event);
    } catch {
      // ignore persistence errors
    }
  }
  // Quota routing mode: health/cooldown must be driven by quotaView only (host/core quota center).
  // VirtualRouter must not produce or persist its own cooldown state in this mode.
  // 当 Host 注入 quotaView 时，VirtualRouter 的入池/优先级决策应以 quota 为准；
  // 此时不再在 engine-health 内部进行 429/backoff/series cooldown 等健康决策，
  // 以避免与 daemon/quota-center 的长期熔断策略重复维护并导致日志噪声。
  if (engine.quotaView) {
    return;
  }
  // Antigravity account safety policy uses router-local cooldown TTLs; only applies when quota routing is disabled.
  applyAntigravityRiskPolicyImpl(
    event,
    engine.providerRegistry,
    engine.healthManager,
    (key, ttl) => markProviderCooldown(engine, key, ttl),
    engine.debug
  );
  // 配额恢复事件优先处理：一旦识别到 virtualRouterQuotaRecovery，
  // 直接清理健康状态/冷却 TTL，避免继续走常规错误映射逻辑。
  const handledByQuota = applyQuotaRecoveryImpl(
    event,
    engine.healthManager,
    (key) => clearProviderCooldown(engine, key),
    engine.debug
  );
  if (handledByQuota) {
    return;
  }
  const handledByQuotaDepleted = applyQuotaDepletedImpl(
    event,
    engine.healthManager,
    (key, ttl) => markProviderCooldown(engine, key, ttl),
    engine.debug
  );
  if (handledByQuotaDepleted) {
    return;
  }
  applySeriesCooldownImpl(
    event,
    engine.providerRegistry,
    engine.healthManager,
    (key, ttl) => markProviderCooldown(engine, key, ttl),
    engine.debug
  );
  const derived = mapProviderErrorImpl(event, providerHealthConfig(engine));
  if (!derived) {
    return;
  }
  handleProviderFailure(engine, derived);
}

export function handleProviderSuccess(engine: VirtualRouterEngine, event: ProviderSuccessEvent): void {
  if (!event || typeof event !== 'object') {
    return;
  }
  const providerKey =
    event.runtime && typeof event.runtime.providerKey === 'string' ? event.runtime.providerKey.trim() : '';
  if (!providerKey) {
    return;
  }
  const metadata =
    event.metadata && typeof event.metadata === 'object' && !Array.isArray(event.metadata)
      ? (event.metadata as Record<string, unknown>)
      : null;
  if (!metadata) {
    return;
  }
  if (providerKey.toLowerCase().startsWith('antigravity.')) {
    recordAntigravitySessionLease({
      metadata: metadata as any,
      providerKey,
      sessionKey: engine.resolveSessionScope(metadata as any),
      providerRegistry: engine.providerRegistry,
      leaseStore: engine.stickySessionManager.getAllStores().aliasLeaseStore,
      sessionAliasStore: engine.stickySessionManager.getAllStores().sessionAliasStore,
      persistence: engine.antigravityLeasePersistence,
      aliasReuseCooldownMs: engine.stickySessionManager.getAliasReuseCooldownMs(),
      commitSessionBinding: true,
      debug: engine.debug
    });
  }
}
