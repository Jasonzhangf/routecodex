import type { ProcessedRequest, StandardizedRequest } from '../../conversion/hub/types/standardized.js';
import {
  createVirtualRouterRouteHostEffects,
  injectVirtualRouterRuntimeMetadata
} from '../../runtime/virtual-router-host-effects.js';
import type {
  ProviderErrorEvent,
  ProviderFailureEvent,
  ProviderSuccessEvent,
  RouterMetadataInput,
  RoutingDecision,
  RoutingDiagnostics,
  RoutingStatusSnapshot,
  VirtualRouterDryRunDiagnostics,
  StopMessageStateSnapshot,
  PreCommandStateSnapshot,
  TargetMetadata,
  VirtualRouterConfig,
  VirtualRouterHealthStore
} from './virtual-router-contracts.js';
import { VirtualRouterError, VirtualRouterErrorCode } from './native-router-hotpath-policy.js';
import {
  createVirtualRouterEngineProxy,
  type NativeVirtualRouterEngineProxy
} from './native-virtual-router-engine-proxy.js';
import {
  extractVirtualRouterNativeErrorMessage,
  parseVirtualRouterNativeError,
  VIRTUAL_ROUTER_ERROR_PREFIX
} from './native-router-hotpath-loader.js';
import { callNativeJson } from './native-router-hotpath.js';
import { failNativeRequired } from './native-router-hotpath-policy.js';

export type {
  ClassificationResult,
  ProviderProfile,
  RouterMetadataInput,
  RoutingDecision,
  RoutingDiagnostics,
  RoutingFeatures,
  RoutingInstructionMode,
  RoutingStatusSnapshot,
  StopMessageStateSnapshot,
  TargetMetadata,
  VirtualRouterConfig,
  VirtualRouterContextRoutingConfig,
  VirtualRouterDryRunDiagnostics,
  VirtualRouterHealthStore
} from './virtual-router-contracts.js';

type TokenEstimateOutput = {
  tokens?: unknown;
};

export type VirtualRouterRuntimeDeps = {
  healthStore?: VirtualRouterHealthStore;
  routingStateStore?: {
    loadSync: (key: string) => unknown;
    saveAsync: (key: string, state: unknown) => void;
    saveSync?: (key: string, state: unknown) => void;
  };
};

export type VirtualRouterRuntime = {
  initialize(config: VirtualRouterConfig): void;
  updateDeps(deps: {
    healthStore?: VirtualRouterHealthStore | null;
    routingStateStore?: VirtualRouterRuntimeDeps['routingStateStore'] | null;
  }): void;
  updateVirtualRouterConfig(config: VirtualRouterConfig): void;
  route(
    request: StandardizedRequest | ProcessedRequest | Record<string, unknown>,
    metadata: RouterMetadataInput | Record<string, unknown>
  ): { target: TargetMetadata; decision: RoutingDecision; diagnostics: RoutingDiagnostics };
  getStopMessageState(metadata: RouterMetadataInput | Record<string, unknown>): StopMessageStateSnapshot | null;
  getPreCommandState(metadata: RouterMetadataInput | Record<string, unknown>): PreCommandStateSnapshot | null;
  markProviderCooldown(providerKey: string, cooldownMs: number | undefined): void;
  clearProviderCooldown(providerKey: string): void;
  markConcurrencyScopeBusy(scopeKey: string): void;
  markConcurrencyScopeIdle(scopeKey: string): void;
  handleProviderFailure(event: ProviderFailureEvent): void;
  handleProviderError(event: ProviderErrorEvent): void;
  handleProviderSuccess(event: ProviderSuccessEvent): void;
  getStatus(): RoutingStatusSnapshot;
  diagnoseRoute(
    request: StandardizedRequest | ProcessedRequest | Record<string, unknown>,
    metadata: RouterMetadataInput | Record<string, unknown>
  ): VirtualRouterDryRunDiagnostics;
  resetProviderQuota(providerKey: string): void;
  recoverProviderQuota(providerKey: string): void;
  disableProviderQuota(providerKey: string, mode: 'cooldown' | 'blacklist', durationMs: number): void;
  applyKeepPoolCooldownQuota(providerKey: string, cooldownUntilMs: number, lastErrorCode?: string): void;
  registerProviderRuntimeIngress(): void;
  unregisterProviderRuntimeIngress(): void;
};

export class VirtualRouterEngine implements VirtualRouterRuntime {
  private readonly nativeProxy: NativeVirtualRouterEngineProxy;

  constructor(deps?: VirtualRouterRuntimeDeps) {
    this.nativeProxy = createVirtualRouterEngineProxy();
    if (deps) {
      this.nativeProxy.updateDeps(deps as unknown as object);
    }
  }

  initialize(config: VirtualRouterConfig): void {
    assertNativeVoidResult(this.nativeProxy.initialize(JSON.stringify(config)));
  }

  updateDeps(deps: {
    healthStore?: VirtualRouterHealthStore | null;
    routingStateStore?: VirtualRouterRuntimeDeps['routingStateStore'] | null;
  }): void {
    this.nativeProxy.updateDeps(deps as unknown as object);
  }

  updateVirtualRouterConfig(config: VirtualRouterConfig): void {
    assertNativeVoidResult(this.nativeProxy.updateVirtualRouterConfig(JSON.stringify(config)));
  }

  route(
    request: StandardizedRequest | ProcessedRequest | Record<string, unknown>,
    metadata: RouterMetadataInput | Record<string, unknown> = {}
  ): { target: TargetMetadata; decision: RoutingDecision; diagnostics: RoutingDiagnostics } {
    const routeHostEffects = createVirtualRouterRouteHostEffects({ request, metadata });
    const nativeMetadata = injectVirtualRouterRuntimeMetadata(metadata);
    let raw: unknown;
    try {
      raw = this.nativeProxy.route(JSON.stringify(request), JSON.stringify(nativeMetadata));
    } catch (error) {
      throw normalizeNativeVirtualRouterError(error);
    }
    if (typeof raw !== 'string') {
      throw normalizeNativeVirtualRouterError(raw);
    }
    if (raw.startsWith('Error:') || raw.startsWith(VIRTUAL_ROUTER_ERROR_PREFIX)) {
      throw normalizeNativeVirtualRouterError(raw);
    }
    const parsed = JSON.parse(raw) as {
      target: TargetMetadata;
      decision: RoutingDecision;
      diagnostics: RoutingDiagnostics;
    };
    routeHostEffects.finalize(parsed, (stateMetadata) => this.getStopMessageState(stateMetadata));
    return parsed;
  }

  getStopMessageState(metadata: RouterMetadataInput | Record<string, unknown>): StopMessageStateSnapshot | null {
    const raw = this.nativeProxy.getStopMessageState(JSON.stringify(injectVirtualRouterRuntimeMetadata(metadata)));
    return JSON.parse(raw) as StopMessageStateSnapshot | null;
  }

  getPreCommandState(metadata: RouterMetadataInput | Record<string, unknown>): PreCommandStateSnapshot | null {
    const raw = this.nativeProxy.getPreCommandState(JSON.stringify(injectVirtualRouterRuntimeMetadata(metadata)));
    return JSON.parse(raw) as PreCommandStateSnapshot | null;
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

  diagnoseRoute(
    request: StandardizedRequest | ProcessedRequest | Record<string, unknown>,
    metadata: RouterMetadataInput | Record<string, unknown> = {}
  ): VirtualRouterDryRunDiagnostics {
    if (typeof this.nativeProxy.diagnoseRoute !== 'function') {
      throw new Error('VirtualRouterEngineProxy.diagnoseRoute is not available');
    }
    const nativeMetadata = injectVirtualRouterRuntimeMetadata(metadata);
    const raw = this.nativeProxy.diagnoseRoute(JSON.stringify(request), JSON.stringify(nativeMetadata));
    return JSON.parse(raw) as VirtualRouterDryRunDiagnostics;
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

  registerProviderRuntimeIngress(): void {
    if (typeof this.nativeProxy.registerProviderRuntimeIngress !== 'function') {
      throw new Error('VirtualRouterEngineProxy.registerProviderRuntimeIngress is not available');
    }
    this.nativeProxy.registerProviderRuntimeIngress();
  }

  unregisterProviderRuntimeIngress(): void {
    if (typeof this.nativeProxy.unregisterProviderRuntimeIngress !== 'function') {
      throw new Error('VirtualRouterEngineProxy.unregisterProviderRuntimeIngress is not available');
    }
    this.nativeProxy.unregisterProviderRuntimeIngress();
  }
}

export function createVirtualRouterRuntime(deps?: VirtualRouterRuntimeDeps): VirtualRouterRuntime {
  return new VirtualRouterEngine(deps);
}

function invokeTokenEstimator(request: StandardizedRequest | ProcessedRequest | Record<string, unknown>): number {
  const parsed = callNativeJson(
    'estimateVirtualRouterRequestTokensJson',
    'estimateVirtualRouterRequestTokensJson',
    [JSON.stringify({ request })],
    (raw) => {
      try {
        return JSON.parse(raw) as TokenEstimateOutput;
      } catch {
        return null;
      }
    },
    {
      emptyReason: 'empty result',
      invalidReason: 'invalid result'
    }
  );
  if (typeof parsed.tokens !== 'number' || !Number.isFinite(parsed.tokens)) {
    throw failNativeRequired<number>('estimateVirtualRouterRequestTokensJson', 'invalid token count');
  }
  return Math.max(0, Math.round(parsed.tokens));
}

export function countRequestTokens(request: StandardizedRequest | ProcessedRequest | Record<string, unknown>): number {
  return invokeTokenEstimator(request);
}

export function computeRequestTokens(
  request: StandardizedRequest | ProcessedRequest | Record<string, unknown>,
  _fallbackText = ''
): number {
  return invokeTokenEstimator(request);
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

function assertNativeVoidResult(result: unknown): void {
  if (result === undefined || result === null) {
    return;
  }
  throw normalizeNativeVirtualRouterError(result);
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
