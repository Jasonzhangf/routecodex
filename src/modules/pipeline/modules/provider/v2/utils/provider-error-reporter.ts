import type { ModuleDependencies } from '../../../../interfaces/pipeline-interfaces.js';
import type { ProviderContext } from '../api/provider-types.js';
import type { TargetMetadata } from '../../../../orchestrator/pipeline-context.js';
import type {
  ProviderErrorEvent,
  ProviderErrorRuntimeMetadata
} from 'rcc-llmswitch-core/dist/router/virtual-router/types.js';
import { importCoreModule } from '../../../../../llmswitch/core-loader.js';

type ProviderErrorCenterExports = {
  providerErrorCenter?: {
    emit(event: ProviderErrorEvent): void;
    subscribe?(handler: (event: ProviderErrorEvent) => void): () => void;
  };
};

const providerErrorCenterModule = await importCoreModule<ProviderErrorCenterExports>(
  'router/virtual-router/error-center'
);
const providerErrorCenterResolved = providerErrorCenterModule?.providerErrorCenter;
if (!providerErrorCenterResolved) {
  throw new Error('[provider-error-reporter] 无法加载 llmswitch-core providerErrorCenter（请确认 rcc-llmswitch-core 可用）');
}
const providerErrorCenter = providerErrorCenterResolved;

type CompatContext = {
  requestId: string;
  providerKey?: string;
  providerId?: string;
  providerType?: string;
  providerProtocol?: string;
  routeName?: string;
  pipelineId?: string;
  target?: TargetMetadata;
};

interface EmitOptions {
  error: unknown;
  stage: string;
  runtime: ProviderErrorRuntimeMetadata;
  dependencies: ModuleDependencies;
  statusCode?: number;
  recoverable?: boolean;
  affectsHealth?: boolean;
  details?: Record<string, unknown>;
}

export function emitProviderError(options: EmitOptions): void {
  const err = options.error instanceof Error ? options.error : new Error(String(options.error ?? 'Unknown error'));
  const code = normalizeCode((err as any)?.code, options.stage);
  const status = determineStatusCode(err, options.statusCode);
  const recoverable = options.recoverable ?? ((err as any)?.retryable === true);
  const event: ProviderErrorEvent & { affectsHealth?: boolean } = {
    code,
    message: err.message || code,
    stage: options.stage,
    status,
    recoverable,
    runtime: options.runtime,
    timestamp: Date.now(),
    details: options.details ?? ((err as any)?.details as Record<string, unknown> | undefined)
  };
  event.affectsHealth = options.affectsHealth !== false;
  try {
    providerErrorCenter.emit(event as ProviderErrorEvent);
  } catch (emitError) {
    console.error('[provider-error-reporter] failed to emit provider error', emitError);
  }

  const center = options.dependencies.errorHandlingCenter;
  if (center?.handleError) {
    const severity = status && status >= 500 ? 'error' : 'warn';
    const payload = {
      error: err,
      source: options.stage,
      severity,
      moduleId: options.runtime.providerId,
      requestId: options.runtime.requestId,
      providerKey: options.runtime.providerKey,
      providerType: options.runtime.providerType,
      routeName: options.runtime.routeName,
      metadata: {
        status,
        code,
        runtime: options.runtime,
        details: options.details
      }
    };
    Promise.resolve(center.handleError(payload)).catch((handlerError: unknown) => {
      console.error('[provider-error-reporter] error center handleError failed', handlerError);
    });
  }
}

export function buildRuntimeFromProviderContext(ctx: ProviderContext): ProviderErrorRuntimeMetadata {
  const runtime: ProviderErrorRuntimeMetadata = {
    requestId: ctx.requestId,
    providerKey: ctx.providerKey,
    providerId: ctx.providerId,
    providerType: ctx.providerType,
    providerProtocol: ctx.providerProtocol,
    routeName: ctx.routeName,
    pipelineId: ctx.pipelineId,
    target: ctx.target as any
  };
  (runtime as any).runtimeKey = ctx.runtimeMetadata?.runtimeKey || (ctx.target as any)?.runtimeKey;
  return runtime;
}

export function buildRuntimeFromCompatContext(ctx: CompatContext): ProviderErrorRuntimeMetadata {
  const runtime: ProviderErrorRuntimeMetadata = {
    requestId: ctx.requestId,
    providerKey: ctx.providerKey,
    providerId: ctx.providerId,
    providerType: ctx.providerType,
    providerProtocol: ctx.providerProtocol,
    routeName: ctx.routeName,
    pipelineId: ctx.pipelineId,
    target: ctx.target as any
  };
  (runtime as any).runtimeKey = ctx.target && typeof ctx.target === 'object' ? (ctx.target as any).runtimeKey : undefined;
  return runtime;
}

function determineStatusCode(error: any, fallback?: number): number | undefined {
  if (typeof fallback === 'number') return fallback;
  if (typeof error?.status === 'number') return error.status;
  if (typeof error?.statusCode === 'number') return error.statusCode;
  if (typeof error?.response?.status === 'number') return error.response.status;
  if (typeof error?.details?.status === 'number') return error.details.status;
  const match = typeof error?.message === 'string' ? error.message.match(/HTTP\s+(\d{3})/) : null;
  if (match) return Number(match[1]);
  return undefined;
}

function normalizeCode(rawCode: unknown, stage: string): string {
  if (typeof rawCode === 'string' && rawCode.trim()) {
    return rawCode.toUpperCase();
  }
  if (stage.startsWith('compat')) return 'ERR_COMPATIBILITY';
  if (stage.startsWith('provider')) return 'ERR_PROVIDER_FAILURE';
  return 'ERR_PIPELINE_FAILURE';
}
