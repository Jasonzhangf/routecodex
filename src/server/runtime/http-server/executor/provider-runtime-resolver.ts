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
  const runtimeKey = runtimeKeyHint || runtimeManager.resolveRuntimeKey(target.providerKey);
  if (!runtimeKey) {
    const runtimeMissingError = Object.assign(new Error(`Runtime for provider ${target.providerKey} not initialized`), {
      code: 'ERR_RUNTIME_NOT_FOUND',
      requestId,
      retryable: true
    });
    try {
      const { emitProviderError } = await import('../../../../providers/core/utils/provider-error-reporter.js');
      emitProviderError({
        error: runtimeMissingError,
        stage: 'provider.runtime.resolve',
        runtime: {
          requestId,
          providerKey: target.providerKey,
          providerId: target.providerKey.split('.')[0],
          providerType: String(target.providerType || 'unknown'),
          providerProtocol: String(target.outboundProfile || ''),
          routeName,
          pipelineId: target.providerKey,
          target
        },
        dependencies,
        recoverable: false,
        affectsHealth: true,
        details: {
          reason: 'runtime_not_initialized',
          providerKey: target.providerKey
        }
      });
    } catch {
      // best-effort
    }
    throw Object.assign(new Error(`Runtime for provider ${target.providerKey} not initialized`), {
      code: 'ERR_RUNTIME_NOT_FOUND',
      requestId
    });
  }

  const handle = runtimeManager.getHandleByRuntimeKey(runtimeKey);
  if (!handle) {
    const runtimeMissingError = Object.assign(new Error(`Provider runtime ${runtimeKey} not found`), {
      code: 'ERR_PROVIDER_NOT_FOUND',
      requestId,
      retryable: true
    });
    try {
      const { emitProviderError } = await import('../../../../providers/core/utils/provider-error-reporter.js');
      emitProviderError({
        error: runtimeMissingError,
        stage: 'provider.runtime.resolve',
        runtime: {
          requestId,
          providerKey: target.providerKey,
          providerId: target.providerKey.split('.')[0],
          providerType: String(target.providerType || 'unknown'),
          providerProtocol: String(target.outboundProfile || ''),
          routeName,
          pipelineId: target.providerKey,
          runtimeKey,
          target
        },
        dependencies,
        recoverable: false,
        affectsHealth: true,
        details: {
          reason: 'runtime_handle_missing',
          providerKey: target.providerKey,
          runtimeKey
        }
      });
    } catch {
      // best-effort
    }
    throw Object.assign(new Error(`Provider runtime ${runtimeKey} not found`), {
      code: 'ERR_PROVIDER_NOT_FOUND',
      requestId
    });
  }

  return { runtimeKey, handle };
}
