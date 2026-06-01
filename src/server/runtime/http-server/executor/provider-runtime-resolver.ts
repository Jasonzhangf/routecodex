import type { ProviderHandle } from '../types.js';
import type { ModuleDependencies } from '../../../../modules/pipeline/interfaces/pipeline-interfaces.js';

type RuntimeManager = {
  resolveRuntimeKey(providerKey?: string, fallback?: string, metadata?: Record<string, unknown>): string | undefined;
  getHandleByRuntimeKey(runtimeKey?: string, metadata?: Record<string, unknown>): ProviderHandle | undefined;
};

type RuntimeResolveTarget = {
  providerKey: string;
  outboundProfile?: string;
  providerType?: string;
};

export async function resolveProviderRuntimeOrThrow(options: {
  requestId: string;
  target: RuntimeResolveTarget;
  routeName?: string;
  runtimeKeyHint?: string;
  runtimeManager: RuntimeManager;
  dependencies: ModuleDependencies;
  metadata?: Record<string, unknown>;
}): Promise<{ runtimeKey: string; handle: ProviderHandle }> {
  const { requestId, target, routeName, runtimeKeyHint, runtimeManager, dependencies, metadata } = options;
  void routeName;
  void dependencies;
  let runtimeKey = runtimeManager.resolveRuntimeKey(target.providerKey, undefined, metadata);
  if (!runtimeKey && typeof target.providerKey === 'string') {
    const providerKeyParts = target.providerKey.split('.');
    if (providerKeyParts.length >= 3) {
      const aliasScopedKey = `${providerKeyParts[0]}.${providerKeyParts[1]}`;
      runtimeKey = runtimeManager.resolveRuntimeKey(aliasScopedKey, undefined, metadata);
    }
  }
  if (!runtimeKey) {
    runtimeKey = runtimeKeyHint;
  }
  if (!runtimeKey) {
    const runtimeMissingError = Object.assign(new Error(`Runtime for provider ${target.providerKey} not initialized`), {
      code: 'ERR_RUNTIME_NOT_FOUND',
      requestId,
      retryable: true,
      requestSent: false
    });
    // Preflight/runtime-resolve failed before outbound request dispatch.
    // Do not emit provider-error-center events here to avoid disk-side error spill
    // for requests that never reached upstream provider.
    throw runtimeMissingError;
  }

  const handle = runtimeManager.getHandleByRuntimeKey(runtimeKey, metadata);
  if (!handle) {
    const directHandle = runtimeManager.getHandleByRuntimeKey(target.providerKey, metadata);
    if (directHandle) {
      return { runtimeKey: target.providerKey, handle: directHandle };
    }
    const providerKeyParts = target.providerKey.split('.');
    if (providerKeyParts.length >= 3) {
      const modelScopedRuntimeKey = `${providerKeyParts[0]}.${providerKeyParts[1]}.${providerKeyParts[2]}`;
      const modelScopedHandle = runtimeManager.getHandleByRuntimeKey(modelScopedRuntimeKey, metadata);
      if (modelScopedHandle) {
        return { runtimeKey: modelScopedRuntimeKey, handle: modelScopedHandle };
      }
    }
    const normalizedProviderKey = target.providerKey.replace(/\.key(\d+)\./i, '.$1.');
    if (normalizedProviderKey !== target.providerKey) {
      const normalizedHandle = runtimeManager.getHandleByRuntimeKey(normalizedProviderKey, metadata);
      if (normalizedHandle) {
        return { runtimeKey: normalizedProviderKey, handle: normalizedHandle };
      }
    }
    const normalizedRuntimeKey = runtimeKey.replace(/\.key(\d+)$/i, '.$1');
    if (normalizedRuntimeKey !== runtimeKey) {
      const normalizedRuntimeHandle = runtimeManager.getHandleByRuntimeKey(normalizedRuntimeKey, metadata);
      if (normalizedRuntimeHandle) {
        return { runtimeKey: normalizedRuntimeKey, handle: normalizedRuntimeHandle };
      }
    }
    const runtimeMissingError = Object.assign(new Error(`Provider runtime ${runtimeKey} not found`), {
      code: 'ERR_PROVIDER_NOT_FOUND',
      requestId,
      retryable: true,
      requestSent: false
    });
    // Preflight/runtime-resolve failed before outbound request dispatch.
    // Do not emit provider-error-center events here to avoid disk-side error spill
    // for requests that never reached upstream provider.
    throw runtimeMissingError;
  }

  return { runtimeKey, handle };
}
