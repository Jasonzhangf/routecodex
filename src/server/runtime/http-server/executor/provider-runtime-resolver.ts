import type { ProviderHandle } from '../types.js';
import type { ModuleDependencies } from '../../../../modules/pipeline/interfaces/pipeline-interfaces.js';

export const SERVER_RUNTIME_KEY_RESOLUTION_FEATURE_ID = 'feature_id: server.runtime_key_resolution';

type RuntimeManager = {
  resolveRuntimeKey(providerKey?: string, metadata?: Record<string, unknown>): string | undefined;
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
  let runtimeKey = runtimeManager.resolveRuntimeKey(target.providerKey, metadata);
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
