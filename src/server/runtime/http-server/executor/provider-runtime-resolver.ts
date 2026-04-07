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

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || `${error.name}: ${error.message}`;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function logRuntimeResolveNonBlockingError(
  stage: string,
  error: unknown,
  details: Record<string, unknown>
): void {
  try {
    const detailSuffix = Object.keys(details).length > 0 ? ` details=${JSON.stringify(details)}` : '';
    console.warn(
      `[provider-runtime-resolver] ${stage} failed (non-blocking): ${formatUnknownError(error)}${detailSuffix}`
    );
  } catch {
    // Never throw from non-blocking logging.
  }
}

export async function resolveProviderRuntimeOrThrow(options: {
  requestId: string;
  target: RuntimeResolveTarget;
  routeName?: string;
  runtimeKeyHint?: string;
  runtimeManager: RuntimeManager;
  dependencies: ModuleDependencies;
}): Promise<{ runtimeKey: string; handle: ProviderHandle }> {
  const { requestId, target, routeName, runtimeKeyHint, runtimeManager, dependencies } = options;
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
        recoverable: true,
        affectsHealth: false,
        details: {
          reason: 'runtime_not_initialized',
          providerKey: target.providerKey
        }
      });
    } catch (emitError) {
      logRuntimeResolveNonBlockingError('emitProviderError.runtime_not_initialized', emitError, {
        requestId,
        providerKey: target.providerKey,
        routeName
      });
    }
    throw Object.assign(new Error(`Runtime for provider ${target.providerKey} not initialized`), {
      code: 'ERR_RUNTIME_NOT_FOUND',
      requestId,
      retryable: true
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
        recoverable: true,
        affectsHealth: false,
        details: {
          reason: 'runtime_handle_missing',
          providerKey: target.providerKey,
          runtimeKey
        }
      });
    } catch (emitError) {
      logRuntimeResolveNonBlockingError('emitProviderError.runtime_handle_missing', emitError, {
        requestId,
        providerKey: target.providerKey,
        runtimeKey,
        routeName
      });
    }
    throw Object.assign(new Error(`Provider runtime ${runtimeKey} not found`), {
      code: 'ERR_PROVIDER_NOT_FOUND',
      requestId,
      retryable: true
    });
  }

  return { runtimeKey, handle };
}
