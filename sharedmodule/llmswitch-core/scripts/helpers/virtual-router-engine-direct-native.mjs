import path from 'node:path';
import { createRequire } from 'node:module';
import { parseVirtualRouterNativeError } from './native-router-hotpath-loader.mjs';

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
  const parsed = parseVirtualRouterNativeError(error);
  if (parsed) return parsed;
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
    try {
      return parseNativeRoute(
        this.nativeProxy.route(
          JSON.stringify(request),
          JSON.stringify(injectVirtualRouterRuntimeMetadata(metadata))
        )
      );
    } catch (error) {
      throw normalizeNativeVirtualRouterError(error);
    }
  }

  diagnoseRoute(request, metadata = {}) {
    if (typeof this.nativeProxy.diagnoseRoute !== 'function') {
      throw new Error('VirtualRouterEngineProxy.diagnoseRoute is not available');
    }
    try {
      return JSON.parse(
        this.nativeProxy.diagnoseRoute(
          JSON.stringify(request),
          JSON.stringify(injectVirtualRouterRuntimeMetadata(metadata))
        )
      );
    } catch (error) {
      throw normalizeNativeVirtualRouterError(error);
    }
  }

  getStopMessageState(metadata = {}) {
    try {
      return JSON.parse(
        this.nativeProxy.getStopMessageState(JSON.stringify(injectVirtualRouterRuntimeMetadata(metadata)))
      );
    } catch (error) {
      throw normalizeNativeVirtualRouterError(error);
    }
  }

  getPreCommandState(metadata = {}) {
    try {
      return JSON.parse(
        this.nativeProxy.getPreCommandState(JSON.stringify(injectVirtualRouterRuntimeMetadata(metadata)))
      );
    } catch (error) {
      throw normalizeNativeVirtualRouterError(error);
    }
  }

  markProviderCooldown(providerKey, cooldownMs) {
    try {
      this.nativeProxy.markProviderCooldown(providerKey, cooldownMs);
    } catch (error) {
      throw normalizeNativeVirtualRouterError(error);
    }
  }

  clearProviderCooldown(providerKey) {
    try {
      this.nativeProxy.clearProviderCooldown(providerKey);
    } catch (error) {
      throw normalizeNativeVirtualRouterError(error);
    }
  }

  handleProviderFailure(event) {
    try {
      this.nativeProxy.handleProviderFailure(JSON.stringify(event));
    } catch (error) {
      throw normalizeNativeVirtualRouterError(error);
    }
  }

  handleProviderError(event) {
    try {
      this.nativeProxy.handleProviderError(JSON.stringify(event));
    } catch (error) {
      throw normalizeNativeVirtualRouterError(error);
    }
  }

  handleProviderSuccess(event) {
    try {
      this.nativeProxy.handleProviderSuccess(JSON.stringify(event));
    } catch (error) {
      throw normalizeNativeVirtualRouterError(error);
    }
  }

  getStatus() {
    try {
      return JSON.parse(this.nativeProxy.getStatus());
    } catch (error) {
      throw normalizeNativeVirtualRouterError(error);
    }
  }

  resetProviderQuota(providerKey) {
    try {
      this.nativeProxy.resetProviderQuota?.(providerKey);
    } catch (error) {
      throw normalizeNativeVirtualRouterError(error);
    }
  }

  recoverProviderQuota(providerKey) {
    try {
      this.nativeProxy.recoverProviderQuota?.(providerKey);
    } catch (error) {
      throw normalizeNativeVirtualRouterError(error);
    }
  }

  disableProviderQuota(providerKey, mode, durationMs) {
    try {
      this.nativeProxy.disableProviderQuota?.(providerKey, mode, durationMs);
    } catch (error) {
      throw normalizeNativeVirtualRouterError(error);
    }
  }

  applyKeepPoolCooldownQuota(providerKey, cooldownUntilMs, lastErrorCode) {
    try {
      this.nativeProxy.applyKeepPoolCooldownQuota?.(providerKey, cooldownUntilMs, lastErrorCode);
    } catch (error) {
      throw normalizeNativeVirtualRouterError(error);
    }
  }

  registerProviderRuntimeIngress() {
    if (typeof this.nativeProxy.registerProviderRuntimeIngress !== 'function') {
      throw new Error('VirtualRouterEngineProxy.registerProviderRuntimeIngress is not available');
    }
    try {
      this.nativeProxy.registerProviderRuntimeIngress();
    } catch (error) {
      throw normalizeNativeVirtualRouterError(error);
    }
  }

  unregisterProviderRuntimeIngress() {
    if (typeof this.nativeProxy.unregisterProviderRuntimeIngress !== 'function') {
      throw new Error('VirtualRouterEngineProxy.unregisterProviderRuntimeIngress is not available');
    }
    try {
      this.nativeProxy.unregisterProviderRuntimeIngress();
    } catch (error) {
      throw normalizeNativeVirtualRouterError(error);
    }
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
