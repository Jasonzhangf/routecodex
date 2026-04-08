import type { ProviderHandle } from '../types.js';
import type { ModuleDependencies } from '../../../../modules/pipeline/interfaces/pipeline-interfaces.js';

type RuntimeManager = {
  resolveRuntimeKey(providerKey?: string, fallback?: string): string | undefined;
  getHandleByRuntimeKey(runtimeKey?: string): ProviderHandle | undefined;
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
}): Promise<{ runtimeKey: string; handle: ProviderHandle }> {
  const { requestId, target, routeName, runtimeKeyHint, runtimeManager, dependencies } = options;
  void routeName;
  void dependencies;
  let runtimeKey = runtimeManager.resolveRuntimeKey(target.providerKey);
  if (!runtimeKey && typeof target.providerKey === 'string') {
    const providerKeyParts = target.providerKey.split('.');
    if (providerKeyParts.length >= 3) {
      const aliasScopedKey = `${providerKeyParts[0]}.${providerKeyParts[1]}`;
      runtimeKey = runtimeManager.resolveRuntimeKey(aliasScopedKey);
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

  const handle = runtimeManager.getHandleByRuntimeKey(runtimeKey);
  if (!handle) {
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
