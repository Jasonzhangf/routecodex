import path from 'node:path';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const nativeBinding = nodeRequire(
  path.resolve(repoRoot, 'dist/native/router_hotpath_napi.node')
);

function nativeFn(name) {
  const fn = nativeBinding[name];
  if (typeof fn !== 'function') {
    throw new Error(`${name} native export is required`);
  }
  return fn;
}

function normalizeNativeVirtualRouterError(error) {
  if (error instanceof Error) return error;
  if (typeof error === 'string' && error.startsWith('VIRTUAL_ROUTER_ERROR:')) {
    try {
      const parsed = JSON.parse(error.slice('VIRTUAL_ROUTER_ERROR:'.length));
      const wrapped = new Error(String(parsed.message || 'Virtual router error'));
      wrapped.code = parsed.code;
      wrapped.details = parsed.details;
      return wrapped;
    } catch {
      return new Error(error);
    }
  }
  return new Error(String(error ?? 'Virtual router error'));
}

function assertNativeVoidResult(raw) {
  if (raw === undefined || raw === null) return;
  if (typeof raw === 'string' && raw.length === 0) return;
  throw normalizeNativeVirtualRouterError(raw);
}

function injectVirtualRouterRuntimeMetadata(metadata = {}) {
  const metadataRecord = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? metadata
    : {};
  const existingSnapshot = metadataRecord.metadataCenterSnapshot
    && typeof metadataRecord.metadataCenterSnapshot === 'object'
    && !Array.isArray(metadataRecord.metadataCenterSnapshot)
    ? metadataRecord.metadataCenterSnapshot
    : {};
  const existingRt = metadataRecord.__rt && typeof metadataRecord.__rt === 'object' && !Array.isArray(metadataRecord.__rt)
    ? metadataRecord.__rt
    : {};
  const runtimeControl = existingSnapshot.runtimeControl
    && typeof existingSnapshot.runtimeControl === 'object'
    && !Array.isArray(existingSnapshot.runtimeControl)
    ? { ...existingSnapshot.runtimeControl }
    : {};
  for (const key of ['sessionDir', 'session_dir', 'rccUserDir', 'rcc_user_dir']) {
    if (existingRt[key] !== undefined && runtimeControl[key] === undefined) {
      runtimeControl[key] = existingRt[key];
    }
  }
  const metadataCenterSnapshot = {
    ...existingSnapshot,
    runtimeControl
  };
  for (const key of [
    'requestId',
    'sessionId',
    'conversationId',
    'tmuxSessionId',
    'clientTmuxSessionId',
    'entryEndpoint',
    'processMode',
    'stream',
    'direction',
    'providerProtocol',
    'stage',
    'routeHint',
    'serverToolRequired',
    'excludedProviderKeys',
    'allowedProviders',
    'disabledProviderKeyAliases',
    'continuation',
    'retryProviderKey'
  ]) {
    if (metadataRecord[key] !== undefined && metadataCenterSnapshot[key] === undefined) {
      metadataCenterSnapshot[key] = metadataRecord[key];
    }
  }
  const topLevelRouteControls = {};
  for (const key of ['requestId', 'sessionId', 'conversationId', 'excludedProviderKeys', 'continuation']) {
    if (metadataRecord[key] !== undefined) {
      metadataCenterSnapshot[key] = metadataRecord[key];
      topLevelRouteControls[key] = metadataRecord[key];
    } else if (existingSnapshot[key] !== undefined) {
      topLevelRouteControls[key] = existingSnapshot[key];
    }
  }
  return {
    ...metadataRecord,
    ...topLevelRouteControls,
    metadataCenterSnapshot,
    __rt: {
      ...existingRt,
      nowMs: Date.now()
    }
  };
}

function parseNativeRoute(raw) {
  if (typeof raw !== 'string' || raw.startsWith('Error:') || raw.startsWith('VIRTUAL_ROUTER_ERROR:')) {
    throw normalizeNativeVirtualRouterError(raw);
  }
  return JSON.parse(raw);
}

const ProxyCtor = nativeFn('VirtualRouterEngineProxy');

export class VirtualRouterEngine {
  constructor(deps) {
    this.nativeProxy = new ProxyCtor();
    if (deps) {
      this.nativeProxy.updateDeps(deps);
    }
  }

  initialize(config) {
    assertNativeVoidResult(this.nativeProxy.initialize(JSON.stringify(config)));
  }

  updateVirtualRouterConfig(config) {
    assertNativeVoidResult(this.nativeProxy.updateVirtualRouterConfig(JSON.stringify(config)));
  }

  updateDeps(deps) {
    this.nativeProxy.updateDeps(deps);
  }

  route(request, metadata = {}) {
    return parseNativeRoute(
      this.nativeProxy.route(
        JSON.stringify(request),
        JSON.stringify(injectVirtualRouterRuntimeMetadata(metadata))
      )
    );
  }

  diagnoseRoute(request, metadata = {}) {
    if (typeof this.nativeProxy.diagnoseRoute !== 'function') {
      throw new Error('VirtualRouterEngineProxy.diagnoseRoute is not available');
    }
    return JSON.parse(
      this.nativeProxy.diagnoseRoute(
        JSON.stringify(request),
        JSON.stringify(injectVirtualRouterRuntimeMetadata(metadata))
      )
    );
  }

  getStopMessageState(metadata = {}) {
    return JSON.parse(
      this.nativeProxy.getStopMessageState(JSON.stringify(injectVirtualRouterRuntimeMetadata(metadata)))
    );
  }

  getPreCommandState(metadata = {}) {
    return JSON.parse(
      this.nativeProxy.getPreCommandState(JSON.stringify(injectVirtualRouterRuntimeMetadata(metadata)))
    );
  }

  markProviderCooldown(providerKey, cooldownMs) {
    this.nativeProxy.markProviderCooldown(providerKey, cooldownMs);
  }

  clearProviderCooldown(providerKey) {
    this.nativeProxy.clearProviderCooldown(providerKey);
  }

  handleProviderFailure(event) {
    this.nativeProxy.handleProviderFailure(JSON.stringify(event));
  }

  handleProviderError(event) {
    this.nativeProxy.handleProviderError(JSON.stringify(event));
  }

  handleProviderSuccess(event) {
    this.nativeProxy.handleProviderSuccess(JSON.stringify(event));
  }

  getStatus() {
    return JSON.parse(this.nativeProxy.getStatus());
  }

  resetProviderQuota(providerKey) {
    this.nativeProxy.resetProviderQuota?.(providerKey);
  }

  recoverProviderQuota(providerKey) {
    this.nativeProxy.recoverProviderQuota?.(providerKey);
  }

  disableProviderQuota(providerKey, mode, durationMs) {
    this.nativeProxy.disableProviderQuota?.(providerKey, mode, durationMs);
  }

  applyKeepPoolCooldownQuota(providerKey, cooldownUntilMs, lastErrorCode) {
    this.nativeProxy.applyKeepPoolCooldownQuota?.(providerKey, cooldownUntilMs, lastErrorCode);
  }

  registerProviderRuntimeIngress() {
    if (typeof this.nativeProxy.registerProviderRuntimeIngress !== 'function') {
      throw new Error('VirtualRouterEngineProxy.registerProviderRuntimeIngress is not available');
    }
    this.nativeProxy.registerProviderRuntimeIngress();
  }

  unregisterProviderRuntimeIngress() {
    if (typeof this.nativeProxy.unregisterProviderRuntimeIngress !== 'function') {
      throw new Error('VirtualRouterEngineProxy.unregisterProviderRuntimeIngress is not available');
    }
    this.nativeProxy.unregisterProviderRuntimeIngress();
  }
}

export function countRequestTokens(request) {
  const raw = nativeFn('estimateVirtualRouterRequestTokensJson')(JSON.stringify({ request }));
  const parsed = JSON.parse(String(raw));
  if (!Number.isSafeInteger(parsed.tokens) || parsed.tokens < 0) {
    throw new Error('estimateVirtualRouterRequestTokensJson returned invalid token count');
  }
  return parsed.tokens;
}

export function computeRequestTokens(request) {
  return countRequestTokens(request);
}
