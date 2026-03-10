import { ProviderHealthManager } from './health-manager.js';
import { ProviderRegistry } from './provider-registry.js';
import { RouteLoadBalancer } from './load-balancer.js';
import { RoutingClassifier } from './classifier.js';
import { ContextAdvisor } from './context-advisor.js';
import type { ProcessedRequest, StandardizedRequest } from '../../conversion/hub/types/standardized.js';
import {
  DEFAULT_ROUTE,
  type RoutingPools,
  type RoutingDecision,
  type RoutingDiagnostics,
  type StopMessageStateSnapshot,
  type PreCommandStateSnapshot,
  type RoutePoolTier,
  type RouterMetadataInput,
  type RoutingFeatures,
  type VirtualRouterConfig,
  type VirtualRouterContextRoutingConfig,
  type TargetMetadata,
  type RoutingStatusSnapshot,
  type ProviderFailureEvent,
  type ProviderErrorEvent,
  type ProviderSuccessEvent,
  type VirtualRouterHealthStore
} from './types.js';
import type { RoutingInstructionState } from './routing-instructions.js';
import type { ProviderQuotaView } from './types.js';
import { getStatsCenter } from '../../telemetry/stats-center.js';
import { loadRoutingInstructionStateSync, saveRoutingInstructionStateAsync, saveRoutingInstructionStateSync } from './sticky-session-store.js';
import type { RoutingInstructionStateStoreLike } from './engine/routing-state/store.js';
import { resolveStickyKey as resolveStickyKeyImpl, resolveSessionScope as resolveSessionScopeImpl } from './engine/routing-state/keys.js';
import { RouteAnalytics } from './engine/route-analytics.js';
import { StickySessionManager } from './engine/sticky-session-manager.js';
import { CooldownManager } from './engine/cooldown-manager.js';
import { VirtualRouterEngine as NativeVirtualRouterEngine } from './engine.js';
import { updateDeps as updateDepsImpl, initialize as initializeImpl } from './engine-legacy/config.js';
import {
  handleProviderError as handleProviderErrorImpl,
  handleProviderFailure as handleProviderFailureImpl,
  handleProviderSuccess as handleProviderSuccessImpl,
  buildHealthSnapshot as buildHealthSnapshotImpl,
  persistHealthSnapshot as persistHealthSnapshotImpl,
  markProviderCooldown as markProviderCooldownImpl,
  clearProviderCooldown as clearProviderCooldownImpl,
  isProviderCoolingDown as isProviderCoolingDownImpl,
  getProviderCooldownRemainingMs as getProviderCooldownRemainingMsImpl,
  restoreHealthFromStore as restoreHealthFromStoreImpl
} from './engine-legacy/health.js';
import { selectProvider as selectProviderImpl, selectFromCandidates as selectFromCandidatesImpl, selectFromStickyPool as selectFromStickyPoolImpl, extractExcludedProviderKeySet as extractExcludedProviderKeySetImpl } from './engine-legacy/selection-core.js';
import { parseDirectProviderModel as parseDirectProviderModelImpl, shouldFallbackDirectModelForMedia as shouldFallbackDirectModelForMediaImpl } from './engine-legacy/direct-model.js';
import {
  normalizeRouteAlias as normalizeRouteAliasImpl,
  buildRouteCandidates as buildRouteCandidatesImpl,
  reorderForInlineVision as reorderForInlineVisionImpl,
  reorderForPreferredModel as reorderForPreferredModelImpl,
  routeSupportsModel as routeSupportsModelImpl,
  routeSupportsInlineVision as routeSupportsInlineVisionImpl,
  sortByPriority as sortByPriorityImpl,
  routeWeight as routeWeightImpl,
  routeHasForceFlag as routeHasForceFlagImpl,
  routeHasTargets as routeHasTargetsImpl,
  hasPrimaryPool as hasPrimaryPoolImpl,
  sortRoutePools as sortRoutePoolsImpl,
  flattenPoolTargets as flattenPoolTargetsImpl
} from './engine-legacy/route-utils.js';
import {
  resolveSelectionPenalty as resolveSelectionPenaltyImpl,
  resolveInstructionProcessModeForSelection as resolveInstructionProcessModeForSelectionImpl,
  resolveInstructionTarget as resolveInstructionTargetImpl,
  filterCandidatesByRoutingState as filterCandidatesByRoutingStateImpl,
  buildStickyRouteCandidatesFromFiltered as buildStickyRouteCandidatesFromFilteredImpl
} from './engine-legacy/selection-state.js';

const ALLOW_ENGINE_LEGACY_IMPORTS =
  process.env.LLMSWITCH_ALLOW_ENGINE_LEGACY_IMPORTS === '1' ||
  process.env.ROUTECODEX_ALLOW_ENGINE_LEGACY_IMPORTS === '1';

if (!ALLOW_ENGINE_LEGACY_IMPORTS) {
  throw new Error(
    '[engine-legacy] import is fail-closed. Set LLMSWITCH_ALLOW_ENGINE_LEGACY_IMPORTS=1 only for explicit compatibility/debug work.'
  );
}

function warnLegacyCompatibilitySurface(method: string): void {
  const enabled =
    process.env.LLMSWITCH_WARN_LEGACY_SURFACES === '1' ||
    process.env.ROUTECODEX_WARN_LEGACY_SURFACES === '1';
  if (!enabled) {
    return;
  }
  try {
    // eslint-disable-next-line no-console
    console.warn(
      `[engine-legacy] compatibility surface invoked: ${method}. Do not add new runtime logic to engine-legacy helpers.`
    );
  } catch {
    // best-effort only
  }
}

export class VirtualRouterEngine {
  public routing: RoutingPools = {};
  public readonly providerRegistry: ProviderRegistry = new ProviderRegistry();
  public readonly healthManager: ProviderHealthManager = new ProviderHealthManager();
  public loadBalancer: RouteLoadBalancer = new RouteLoadBalancer();
  public classifier: RoutingClassifier = new RoutingClassifier({});
  public readonly contextAdvisor: ContextAdvisor = new ContextAdvisor();
  public contextRouting: VirtualRouterContextRoutingConfig | undefined;
  public readonly routeAnalytics = new RouteAnalytics();
  public stickySessionManager: StickySessionManager = new StickySessionManager();
  public cooldownManager: CooldownManager;
  public antigravityLeasePersistence: {
    loadedOnce: boolean;
    loadedMtimeMs: number | null;
    flushTimer: ReturnType<typeof setTimeout> | null;
  } = { loadedOnce: false, loadedMtimeMs: null, flushTimer: null };
  public readonly debug = console; // thin hook; host may monkey-patch for colored logging
  public healthConfig: VirtualRouterConfig['health'] | null = null;
  public readonly statsCenter = getStatsCenter();
  // Derived flags from VirtualRouterConfig/routing used by process / response layers.
  public webSearchForce: boolean = false;

  public healthStore?: VirtualRouterHealthStore;
  public routingStateStore: RoutingInstructionStateStoreLike = {
    loadSync: loadRoutingInstructionStateSync,
    saveAsync: saveRoutingInstructionStateAsync,
    saveSync: saveRoutingInstructionStateSync
  };

  public routingInstructionState: Map<string, RoutingInstructionState> = new Map();

  public quotaView?: ProviderQuotaView;
  private readonly nativeEngine: NativeVirtualRouterEngine;

  /**
   * Backward-compatible test/debug surface used by existing regression scripts.
   * Keep this as a read-only view over StickySessionManager storage.
   */
  get antigravitySessionAliasStore(): Map<string, string> {
    return this.nativeEngine.antigravitySessionAliasStore;
  }

  constructor(deps?: {
    healthStore?: VirtualRouterHealthStore;
    routingStateStore?: RoutingInstructionStateStoreLike;
    quotaView?: ProviderQuotaView;
  }) {
    this.nativeEngine = new NativeVirtualRouterEngine(deps);
    this.cooldownManager = new CooldownManager({
      healthStore: deps?.healthStore,
      healthConfig: this.healthConfig,
      quotaView: deps?.quotaView
    });
    if (deps?.healthStore) {
      this.healthStore = deps.healthStore;
    }
    if (deps?.routingStateStore) {
      this.routingStateStore = deps.routingStateStore;
    }
    if (deps?.quotaView) {
      this.quotaView = deps.quotaView;
    }
  }

  updateDeps(deps: {
    healthStore?: VirtualRouterHealthStore | null;
    routingStateStore?: RoutingInstructionStateStoreLike | null;
    quotaView?: ProviderQuotaView | null;
  }): void {
    updateDepsImpl(this, deps as any);
    this.nativeEngine.updateDeps(deps as any);
  }

  initialize(config: VirtualRouterConfig): void {
    initializeImpl(this, config);
    this.nativeEngine.initialize(config);
  }

  route(
    request: StandardizedRequest | ProcessedRequest,
    metadata: RouterMetadataInput
  ): { target: TargetMetadata; decision: RoutingDecision; diagnostics: RoutingDiagnostics } {
    return this.nativeEngine.route(request, metadata);
  }

  public getStopMessageState(metadata: RouterMetadataInput): StopMessageStateSnapshot | null {
    return this.nativeEngine.getStopMessageState(metadata);
  }

  public getPreCommandState(metadata: RouterMetadataInput): PreCommandStateSnapshot | null {
    return this.nativeEngine.getPreCommandState(metadata);
  }

  handleProviderFailure(event: ProviderFailureEvent): void {
    handleProviderFailureImpl(this, event);
    this.nativeEngine.handleProviderFailure(event);
  }

  handleProviderError(event: ProviderErrorEvent): void {
    handleProviderErrorImpl(this, event);
    this.nativeEngine.handleProviderError(event);
  }

  handleProviderSuccess(event: ProviderSuccessEvent): void {
    handleProviderSuccessImpl(this, event);
    this.nativeEngine.handleProviderSuccess(event);
  }

  getStatus(): RoutingStatusSnapshot {
    return this.nativeEngine.getStatus();
  }

  normalizeRouteAlias(routeName: string | undefined): string {
    warnLegacyCompatibilitySurface('normalizeRouteAlias');
    return normalizeRouteAliasImpl(routeName);
  }

  buildRouteCandidates(
    requestedRoute: string,
    classificationCandidates: string[] | undefined,
    features: RoutingFeatures
  ): string[] {
    warnLegacyCompatibilitySurface('buildRouteCandidates');
    return buildRouteCandidatesImpl(this, requestedRoute, classificationCandidates, features);
  }

  reorderForInlineVision(routeNames: string[]): string[] {
    warnLegacyCompatibilitySurface('reorderForInlineVision');
    return reorderForInlineVisionImpl(this, routeNames);
  }

  reorderForPreferredModel(routeNames: string[], modelId: string): string[] {
    warnLegacyCompatibilitySurface('reorderForPreferredModel');
    return reorderForPreferredModelImpl(this, routeNames, modelId);
  }

  routeSupportsModel(routeName: string, modelId: string): boolean {
    warnLegacyCompatibilitySurface('routeSupportsModel');
    return routeSupportsModelImpl(this, routeName, modelId);
  }

  routeSupportsInlineVision(routeName: string): boolean {
    warnLegacyCompatibilitySurface('routeSupportsInlineVision');
    return routeSupportsInlineVisionImpl(this, routeName);
  }

  sortByPriority(routeNames: string[]): string[] {
    warnLegacyCompatibilitySurface('sortByPriority');
    return sortByPriorityImpl(routeNames);
  }

  routeWeight(routeName: string): number {
    warnLegacyCompatibilitySurface('routeWeight');
    return routeWeightImpl(routeName);
  }

  routeHasForceFlag(routeName: string): boolean {
    warnLegacyCompatibilitySurface('routeHasForceFlag');
    return routeHasForceFlagImpl(this, routeName);
  }

  routeHasTargets(pools?: RoutePoolTier[]): boolean {
    warnLegacyCompatibilitySurface('routeHasTargets');
    return routeHasTargetsImpl(this, pools);
  }

  hasPrimaryPool(pools?: RoutePoolTier[]): boolean {
    warnLegacyCompatibilitySurface('hasPrimaryPool');
    return hasPrimaryPoolImpl(this, pools);
  }

  sortRoutePools(pools?: RoutePoolTier[]): RoutePoolTier[] {
    warnLegacyCompatibilitySurface('sortRoutePools');
    return sortRoutePoolsImpl(this, pools);
  }

  flattenPoolTargets(pools?: RoutePoolTier[]): string[] {
    warnLegacyCompatibilitySurface('flattenPoolTargets');
    return flattenPoolTargetsImpl(this, pools);
  }

  markProviderCooldown(providerKey: string, cooldownMs: number | undefined): void {
    markProviderCooldownImpl(this, providerKey, cooldownMs);
    this.nativeEngine.markProviderCooldown(providerKey, cooldownMs);
  }

  clearProviderCooldown(providerKey: string): void {
    clearProviderCooldownImpl(this, providerKey);
    this.nativeEngine.clearProviderCooldown(providerKey);
  }

  isProviderCoolingDown(providerKey: string): boolean {
    return isProviderCoolingDownImpl(this, providerKey);
  }

  getProviderCooldownRemainingMs(providerKey: string): number {
    return getProviderCooldownRemainingMsImpl(this, providerKey);
  }

  restoreHealthFromStore(): void {
    restoreHealthFromStoreImpl(this);
  }

  buildHealthSnapshot() {
    return buildHealthSnapshotImpl(this);
  }

  persistHealthSnapshot(): void {
    persistHealthSnapshotImpl(this);
  }

  parseDirectProviderModel(model: string | undefined): { providerId: string; modelId: string } | null {
    return parseDirectProviderModelImpl(this, model);
  }

  shouldFallbackDirectModelForMedia(direct: { providerId: string; modelId: string }, features: RoutingFeatures): boolean {
    return shouldFallbackDirectModelForMediaImpl(this, direct, features);
  }

  selectProvider(
    requestedRoute: string,
    metadata: RouterMetadataInput,
    classification: any,
    features: RoutingFeatures,
    routingState?: RoutingInstructionState
  ): { providerKey: string; routeUsed: string; pool: string[]; poolId?: string } {
    warnLegacyCompatibilitySurface('selectProvider');
    return selectProviderImpl(this, requestedRoute, metadata, classification, features, routingState);
  }

  selectFromCandidates(
    routes: string[],
    metadata: RouterMetadataInput,
    classification: any,
    features: RoutingFeatures,
    state: RoutingInstructionState,
    requiredProviderKeys?: Set<string>,
    allowAliasRotation?: boolean
  ): { providerKey: string; routeUsed: string; pool: string[]; poolId?: string } {
    warnLegacyCompatibilitySurface('selectFromCandidates');
    return selectFromCandidatesImpl(this, routes, metadata, classification, features, state, requiredProviderKeys, allowAliasRotation);
  }

  selectFromStickyPool(
    stickyKeySet: Set<string>,
    metadata: RouterMetadataInput,
    features: RoutingFeatures,
    state: RoutingInstructionState,
    allowAliasRotation?: boolean
  ): { providerKey: string; routeUsed: string; pool: string[]; poolId?: string } | null {
    warnLegacyCompatibilitySurface('selectFromStickyPool');
    return selectFromStickyPoolImpl(this, stickyKeySet, metadata, features, state, allowAliasRotation);
  }

  extractExcludedProviderKeySet(metadata: RouterMetadataInput | undefined): Set<string> {
    warnLegacyCompatibilitySurface('extractExcludedProviderKeySet');
    return extractExcludedProviderKeySetImpl(this, metadata);
  }

  resolveSelectionPenalty(providerKey: string): number | undefined {
    warnLegacyCompatibilitySurface('resolveSelectionPenalty');
    return resolveSelectionPenaltyImpl(this, providerKey);
  }

  resolveInstructionProcessModeForSelection(
    providerKey: string,
    routingState: RoutingInstructionState
  ): 'chat' | 'passthrough' | undefined {
    warnLegacyCompatibilitySurface('resolveInstructionProcessModeForSelection');
    return resolveInstructionProcessModeForSelectionImpl(this, providerKey, routingState);
  }

  resolveInstructionTarget(
    target: NonNullable<RoutingInstructionState['forcedTarget']>
  ): { mode: 'exact' | 'filter'; keys: string[] } | null {
    warnLegacyCompatibilitySurface('resolveInstructionTarget');
    return resolveInstructionTargetImpl(this, target);
  }

  buildStickyRouteCandidatesFromFiltered(filteredCandidates: string[], stickyKeySet: Set<string>): string[] {
    warnLegacyCompatibilitySurface('buildStickyRouteCandidatesFromFiltered');
    return buildStickyRouteCandidatesFromFilteredImpl(this, filteredCandidates, stickyKeySet);
  }

  filterCandidatesByRoutingState(routes: string[], state: RoutingInstructionState): string[] {
    warnLegacyCompatibilitySurface('filterCandidatesByRoutingState');
    return filterCandidatesByRoutingStateImpl(this, routes, state);
  }

  resolveStickyKey(metadata: RouterMetadataInput): string | undefined {
    warnLegacyCompatibilitySurface('resolveStickyKey');
    return resolveStickyKeyImpl(metadata);
  }

  resolveSessionScope(metadata: RouterMetadataInput): string | undefined {
    warnLegacyCompatibilitySurface('resolveSessionScope');
    return resolveSessionScopeImpl(metadata);
  }
}
