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
  isProviderAtConcurrencyCapacity?: (providerKey: string) => boolean;
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
