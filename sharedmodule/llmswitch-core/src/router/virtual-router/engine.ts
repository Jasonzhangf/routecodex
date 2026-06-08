import type { ProcessedRequest, StandardizedRequest } from '../../conversion/hub/types/standardized.js';
import type {
  ProviderErrorEvent,
  ProviderFailureEvent,
  ProviderQuotaView,
  ProviderSuccessEvent,
  RouterMetadataInput,
  RoutingDecision,
  RoutingDiagnostics,
  RoutingStatusSnapshot,
  StopMessageStateSnapshot,
  PreCommandStateSnapshot,
  TargetMetadata,
  VirtualRouterConfig,
  VirtualRouterHealthStore
} from '../../native/router-hotpath/virtual-router-contracts.js';
import {
  VirtualRouterError,
  VirtualRouterErrorCode,
} from '../../native/router-hotpath/virtual-router-contracts.js';
import { createVirtualRouterEngineProxy, type NativeVirtualRouterEngineProxy } from '../../native/router-hotpath/native-virtual-router-engine-proxy.js';
import {
  extractVirtualRouterNativeErrorMessage,
  parseVirtualRouterNativeError,
  VIRTUAL_ROUTER_ERROR_PREFIX
} from '../../native/router-hotpath/native-router-hotpath-loader.js';
import {
  createVirtualRouterRouteHostEffects,
  injectVirtualRouterRuntimeMetadata,
  mergeVirtualRouterStopMessageSnapshotWithPersisted,
  resolveTmuxScopedVirtualRouterStateScope
} from '../../runtime/virtual-router-host-effects.js';
import { ProviderRegistry } from './provider-registry.js';

export class VirtualRouterEngine {
  private readonly nativeProxy: NativeVirtualRouterEngineProxy;
  private readonly registry: ProviderRegistry;
  private readonly routingInstructionStateStore: Map<string, unknown>;

  constructor(deps?: {
    healthStore?: VirtualRouterHealthStore;
    routingStateStore?: {
      loadSync: (key: string) => unknown;
      saveAsync: (key: string, state: unknown) => void;
      saveSync?: (key: string, state: unknown) => void;
    };
    quotaView?: ProviderQuotaView;
  }) {
    this.nativeProxy = createVirtualRouterEngineProxy();
    this.registry = new ProviderRegistry();
    this.routingInstructionStateStore = new Map();
    if (deps) {
      this.nativeProxy.updateDeps(deps as unknown as object);
    }
  }

  get routingInstructionState(): Map<string, unknown> {
    return this.routingInstructionStateStore;
  }

  get providerRegistry(): unknown {
    return this.registry;
  }

  initialize(config: VirtualRouterConfig): void {
    this.nativeProxy.initialize(JSON.stringify(config));
    this.registry.load(config.providers ?? {});
    this.routingInstructionStateStore.clear();
  }

  updateDeps(deps: {
    healthStore?: VirtualRouterHealthStore | null;
    routingStateStore?: {
      loadSync: (key: string) => unknown;
      saveAsync: (key: string, state: unknown) => void;
      saveSync?: (key: string, state: unknown) => void;
    } | null;
    quotaView?: ProviderQuotaView | null;
  }): void {
    this.nativeProxy.updateDeps(deps as unknown as object);
  }

  updateVirtualRouterConfig(config: VirtualRouterConfig): void {
    this.nativeProxy.updateVirtualRouterConfig(JSON.stringify(config));
    this.registry.load(config.providers ?? {});
  }

  markProviderCooldown(providerKey: string, cooldownMs: number | undefined): void {
    this.nativeProxy.markProviderCooldown(providerKey, cooldownMs);
  }

  clearProviderCooldown(providerKey: string): void {
    this.nativeProxy.clearProviderCooldown(providerKey);
  }

  markConcurrencyScopeBusy(scopeKey: string): void {
    this.nativeProxy.markConcurrencyScopeBusy?.(scopeKey);
  }

  markConcurrencyScopeIdle(scopeKey: string): void {
    this.nativeProxy.markConcurrencyScopeIdle?.(scopeKey);
  }

  route(
    request: StandardizedRequest | ProcessedRequest,
    metadata: RouterMetadataInput = {} as RouterMetadataInput
  ): { target: TargetMetadata; decision: RoutingDecision; diagnostics: RoutingDiagnostics } {
    const routeHostEffects = createVirtualRouterRouteHostEffects({ request, metadata });
    const nativeMetadata = injectVirtualRouterRuntimeMetadata(metadata);
    let raw: unknown;
    try {
      raw = this.nativeProxy.route(JSON.stringify(request), JSON.stringify(nativeMetadata));
    } catch (error) {
      const normalized = normalizeNativeVirtualRouterError(error);
      throw normalized;
    }
    if (typeof raw !== 'string') {
      const normalized = normalizeNativeVirtualRouterError(raw);
      throw normalized;
    }
    if (raw.startsWith('Error:') || raw.startsWith(VIRTUAL_ROUTER_ERROR_PREFIX)) {
      const normalized = normalizeNativeVirtualRouterError(raw);
      throw normalized;
    }
    const parsed = JSON.parse(raw) as {
      target: TargetMetadata;
      decision: RoutingDecision;
      diagnostics: RoutingDiagnostics;
    };
    routeHostEffects.finalize(parsed, (stateMetadata) => this.getStopMessageState(stateMetadata));
    return parsed;
  }

  getStopMessageState(metadata: RouterMetadataInput): StopMessageStateSnapshot | null {
    const scope = resolveTmuxScopedVirtualRouterStateScope(metadata);
    if (!scope) {
      return null;
    }
    const raw = this.nativeProxy.getStopMessageState(JSON.stringify(metadata));
    const snapshot = JSON.parse(raw) as StopMessageStateSnapshot | null;
    return mergeVirtualRouterStopMessageSnapshotWithPersisted(snapshot, scope);
  }

  getPreCommandState(metadata: RouterMetadataInput): PreCommandStateSnapshot | null {
    const scope = resolveTmuxScopedVirtualRouterStateScope(metadata);
    if (!scope) {
      return null;
    }
    const raw = this.nativeProxy.getPreCommandState(JSON.stringify(metadata));
    return JSON.parse(raw) as PreCommandStateSnapshot | null;
  }

  handleProviderFailure(event: ProviderFailureEvent): void {
    this.nativeProxy.handleProviderFailure(JSON.stringify(event));
  }

  handleProviderError(event: ProviderErrorEvent): void {
    this.nativeProxy.handleProviderError(JSON.stringify(event));
  }

  handleProviderSuccess(event: ProviderSuccessEvent): void {
    this.nativeProxy.handleProviderSuccess(JSON.stringify(event));
  }

  getStatus(): RoutingStatusSnapshot {
    return JSON.parse(this.nativeProxy.getStatus()) as RoutingStatusSnapshot;
  }

  resetProviderQuota(providerKey: string): void {
    this.nativeProxy.resetProviderQuota?.(providerKey);
  }

  recoverProviderQuota(providerKey: string): void {
    this.nativeProxy.recoverProviderQuota?.(providerKey);
  }

  disableProviderQuota(providerKey: string, mode: 'cooldown' | 'blacklist', durationMs: number): void {
    this.nativeProxy.disableProviderQuota?.(providerKey, mode, durationMs);
  }

  applyKeepPoolCooldownQuota(providerKey: string, cooldownUntilMs: number, lastErrorCode?: string): void {
    this.nativeProxy.applyKeepPoolCooldownQuota?.(providerKey, cooldownUntilMs, lastErrorCode);
  }
}

function normalizeNativeVirtualRouterError(error: unknown): Error {
  if (error instanceof VirtualRouterError) {
    return error;
  }
  const parsed = parseVirtualRouterNativeError(error);
  if (parsed) {
    return parsed;
  }
  const message = extractVirtualRouterNativeErrorMessage(error);
  if (isVirtualRouterErrorLike(error)) {
    const details =
      (error as { details?: unknown }).details && typeof (error as { details?: unknown }).details === 'object' && !Array.isArray((error as { details?: unknown }).details)
        ? ((error as { details?: unknown }).details as Record<string, unknown>)
        : undefined;
    return new VirtualRouterError(
      typeof error.message === 'string' && error.message.trim() ? error.message : 'Virtual router error',
      error.code,
      details
    );
  }
  return error instanceof Error ? error : new Error(message || 'Virtual router error');
}

function isVirtualRouterErrorCode(value: string): value is VirtualRouterErrorCode {
  return Object.values(VirtualRouterErrorCode).includes(value as VirtualRouterErrorCode);
}

function isVirtualRouterErrorLike(
  error: unknown
): error is { code: VirtualRouterErrorCode; message?: string } {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const record = error as { code?: unknown };
  return typeof record.code === 'string' && isVirtualRouterErrorCode(record.code);
}
