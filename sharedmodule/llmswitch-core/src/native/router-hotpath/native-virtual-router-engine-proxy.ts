import { failNativeRequired } from './native-router-hotpath-policy.js';
import { loadNativeRouterHotpathBindingForInternalUse } from './native-router-hotpath.js';

export interface NativeVirtualRouterEngineProxy {
  initialize(configJson: string): void;
  updateDeps(deps: object): void;
  updateVirtualRouterConfig(configJson: string): void;
  route(requestJson: string, metadataJson: string): string;
  getStopMessageState(metadataJson: string): string;
  getPreCommandState(metadataJson: string): string;
  markProviderCooldown(providerKey: string, cooldownMs?: number): void;
  clearProviderCooldown(providerKey: string): void;
  handleProviderFailure(eventJson: string): void;
  handleProviderError(eventJson: string): void;
  handleProviderSuccess(eventJson: string): void;
  getStatus(): string;
  resetProviderQuota?(providerKey: string): void;
  recoverProviderQuota?(providerKey: string): void;
  disableProviderQuota?(providerKey: string, mode: string, durationMs?: number): void;
  applyKeepPoolCooldownQuota?(providerKey: string, cooldownUntilMs: number, lastErrorCode?: string): void;
  markConcurrencyScopeBusy?(scopeKey: string): void;
  markConcurrencyScopeIdle?(scopeKey: string): void;
  registerProviderRuntimeIngress?(): void;
  unregisterProviderRuntimeIngress?(): void;
}

type ProxyConstructor = new (engine?: object) => NativeVirtualRouterEngineProxy;

function resolveProxyConstructor(): ProxyConstructor {
  const binding = loadNativeRouterHotpathBindingForInternalUse() as Record<string, unknown> | null;
  const ctor = binding?.VirtualRouterEngineProxy;
  if (typeof ctor !== 'function') {
    return failNativeRequired<ProxyConstructor>('VirtualRouterEngineProxy', 'missing native proxy constructor');
  }
  return ctor as ProxyConstructor;
}

export function createVirtualRouterEngineProxy(engine?: object): NativeVirtualRouterEngineProxy {
  const Ctor = resolveProxyConstructor();
  return new Ctor(engine);
}
