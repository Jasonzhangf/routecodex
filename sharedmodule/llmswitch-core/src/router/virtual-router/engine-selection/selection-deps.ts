import type { RoutePoolTier, RouterMetadataInput, RoutingFeatures, ProviderQuotaView } from '../types.js';
import type { ContextAdvisor } from '../context-advisor.js';
import type { RouteLoadBalancer } from '../load-balancer.js';
import type { ProviderHealthManager } from '../health-manager.js';
import type { ProviderRegistry } from '../provider-registry.js';

export type SelectionDeps = {
  routing: Record<string, RoutePoolTier[]>;
  providerRegistry: ProviderRegistry;
  healthManager: ProviderHealthManager;
  contextAdvisor: ContextAdvisor;
  loadBalancer: RouteLoadBalancer;
  isProviderCoolingDown: (providerKey: string) => boolean;
  getProviderCooldownRemainingMs?: (providerKey: string) => number;
  resolveStickyKey: (metadata: RouterMetadataInput) => string | undefined;
  quotaView?: ProviderQuotaView;
  aliasQueueStore?: Map<string, string[]>;
  /**
   * Antigravity alias session lease (session isolation) store.
   * Key: runtimeKey (providerId.keyAlias), e.g. "antigravity.aliasA".
   */
  antigravityAliasLeaseStore?: Map<string, { sessionKey: string; lastSeenAt: number }>;
  /**
   * Session → runtimeKey mapping for Antigravity alias leases.
   * Key: session scope key, e.g. "session:abc" / "conversation:xyz".
   * Value: runtimeKey (providerId.keyAlias)
   */
  antigravitySessionAliasStore?: Map<string, string>;
  /**
   * Cooldown window (ms) before an Antigravity alias can be reused by a different session.
   */
  antigravityAliasReuseCooldownMs?: number;
};

export type TrySelectFromTierOptions = {
  disabledProviders?: Set<string>;
  disabledKeysMap?: Map<string, Set<string | number>>;
  allowedProviders?: Set<string>;
  disabledModels?: Map<string, Set<string>>;
  requiredProviderKeys?: Set<string>;
  allowAliasRotation?: boolean;
};

export type SelectProviderInput = {
  routeName: string;
  tier: RoutePoolTier;
  stickyKey: string | undefined;
  estimatedTokens: number;
  features: RoutingFeatures;
  deps: SelectionDeps;
  options: TrySelectFromTierOptions;
};

export type SelectionResult = { providerKey: string | null; poolTargets: string[]; tierId?: string; failureHint?: string };
