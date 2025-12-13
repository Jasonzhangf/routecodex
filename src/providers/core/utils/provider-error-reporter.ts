import type { ErrorContext } from 'rcc-errorhandling';
import type { ModuleDependencies } from '../../../modules/pipeline/interfaces/pipeline-interfaces.js';
import type { ProviderContext } from '../api/provider-types.js';
import type { TargetMetadata } from '../../../modules/pipeline/orchestrator/pipeline-context.js';
import type {
  ProviderErrorEvent,
  ProviderErrorRuntimeMetadata
} from '@jsonstudio/llms/dist/router/virtual-router/types.js';
import { importCoreModule } from '../../../modules/llmswitch/core-loader.js';
import { formatErrorForErrorCenter } from '../../../utils/error-center-payload.js';
import { getRouteErrorHub, reportRouteError } from '../../../error-handling/route-error-hub.js';

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
  throw new Error('[provider-error-reporter] 无法加载 llmswitch-core providerErrorCenter（请确认 @jsonstudio/llms 可用）');
}
const providerErrorCenter = providerErrorCenterResolved;

type ExtendedRuntimeMetadata = ProviderErrorRuntimeMetadata & {
  providerFamily?: string;
  runtimeKey?: string;
};

type ProviderErrorEventExtended = ProviderErrorEvent & {
  affectsHealth?: boolean;
};

type ErrorWithMetadata = Error & {
  code?: string;
  status?: number;
  statusCode?: number;
  retryable?: boolean;
  details?: Record<string, unknown>;
  response?: {
    status?: number;
  };
};

type CompatContext = {
  requestId: string;
  providerKey?: string;
  providerId?: string;
  providerType?: string;
  providerFamily?: string;
  providerProtocol?: string;
  routeName?: string;
  pipelineId?: string;
  target?: TargetMetadata;
};

interface EmitOptions {
  error: unknown;
  stage: string;
  runtime: ExtendedRuntimeMetadata;
  dependencies: ModuleDependencies;
  statusCode?: number;
  recoverable?: boolean;
  affectsHealth?: boolean;
  details?: Record<string, unknown>;
}

export function emitProviderError(options: EmitOptions): void {
  const err = normalizeError(options.error);
  const code = normalizeCode(err.code, options.stage);
  const status = determineStatusCode(err, options.statusCode);
  const recoverable = options.recoverable ?? (err.retryable === true);
  const event: ProviderErrorEventExtended = {
    code,
    message: err.message || code,
    stage: options.stage,
    status,
    recoverable,
    runtime: options.runtime,
    timestamp: Date.now(),
    details: options.details ?? extractRecord(err.details)
  };
  event.affectsHealth = options.affectsHealth !== false;
  try {
    providerErrorCenter.emit(event);
  } catch (emitError) {
    console.error('[provider-error-reporter] failed to emit provider error', emitError);
  }

  const center = options.dependencies.errorHandlingCenter;
  const hub = getRouteErrorHub();
  if (hub) {
    const targetModel =
      options.runtime.target && typeof options.runtime.target === 'object'
        ? (options.runtime.target as { clientModelId?: string }).clientModelId
        : undefined;
    void reportRouteError({
      code,
      message: err.message || code,
      source: options.stage,
      scope: 'provider',
      severity: status && status >= 500 ? 'high' : 'medium',
      requestId: options.runtime.requestId,
      endpoint: options.runtime.routeName,
      providerKey: options.runtime.providerKey,
      providerType: options.runtime.providerType,
      routeName: options.runtime.routeName,
      model: targetModel,
      details: {
        status,
        recoverable,
        runtime: options.runtime,
        details: options.details
      },
      originalError: err
    }).catch(reportError => {
      console.error('[provider-error-reporter] failed to route provider error via hub', reportError);
    });
  } else if (center?.handleError) {
    const severity: ErrorContext['severity'] = status && status >= 500 ? 'high' : 'medium';
    const targetModel =
      options.runtime.target && typeof options.runtime.target === 'object'
        ? (options.runtime.target as { clientModelId?: string }).clientModelId
        : undefined;
    const extras = {
      requestId: options.runtime.requestId,
      providerKey: options.runtime.providerKey,
      model: targetModel
    };
    const sanitizedContext = formatErrorForErrorCenter({
      requestId: options.runtime.requestId,
      providerKey: options.runtime.providerKey,
      providerType: options.runtime.providerType,
      providerFamily: options.runtime.providerFamily,
      routeName: options.runtime.routeName,
      status,
      code,
      runtime: options.runtime,
      details: options.details
    });
    const payload: ErrorContext = {
      error: err.message || code,
      source: options.stage,
      severity,
      timestamp: Date.now(),
      moduleId: options.runtime.providerId,
      context: typeof sanitizedContext === 'object' && sanitizedContext
        ? sanitizedContext as Record<string, unknown>
        : { details: sanitizedContext }
    };
    void center.handleError(payload).catch((handlerError: unknown) => {
      console.error('[provider-error-reporter] error center handleError failed', handlerError);
    });
  }
}

export function buildRuntimeFromProviderContext(ctx: ProviderContext): ExtendedRuntimeMetadata {
  const runtime: ExtendedRuntimeMetadata = {
    requestId: ctx.requestId,
    providerKey: ctx.providerKey,
    providerId: ctx.providerId,
    providerType: ctx.providerType,
    providerProtocol: ctx.providerProtocol,
    routeName: ctx.routeName,
    pipelineId: ctx.pipelineId,
    target: ctx.target,
    providerFamily: ctx.providerFamily,
    runtimeKey: ctx.runtimeMetadata?.runtimeKey ?? ctx.target?.runtimeKey
  };
  return runtime;
}

export function buildRuntimeFromCompatContext(ctx: CompatContext): ExtendedRuntimeMetadata {
  const runtime: ExtendedRuntimeMetadata = {
    requestId: ctx.requestId,
    providerKey: ctx.providerKey,
    providerId: ctx.providerId,
    providerType: ctx.providerType,
    providerProtocol: ctx.providerProtocol,
    routeName: ctx.routeName,
    pipelineId: ctx.pipelineId,
    target: ctx.target,
    providerFamily: ctx.providerFamily ?? ctx.providerType,
    runtimeKey: ctx.target?.runtimeKey
  };
  return runtime;
}

function determineStatusCode(error: ErrorWithMetadata, fallback?: number): number | undefined {
  if (typeof fallback === 'number') {
    return fallback;
  }
  if (typeof error.status === 'number') {
    return error.status;
  }
  if (typeof error.statusCode === 'number') {
    return error.statusCode;
  }
  if (typeof error.response?.status === 'number') {
    return error.response.status;
  }
  const detailsStatus = extractStatus(error.details);
  if (typeof detailsStatus === 'number') {
    return detailsStatus;
  }
  const match = typeof error.message === 'string' ? error.message.match(/HTTP\s+(\d{3})/) : null;
  if (match) {
    return Number(match[1]);
  }
  return undefined;
}

function normalizeCode(rawCode: unknown, stage: string): string {
  if (typeof rawCode === 'string' && rawCode.trim()) {
    return rawCode.toUpperCase();
  }
  if (stage.startsWith('compat')) {
    return 'ERR_COMPATIBILITY';
  }
  if (stage.startsWith('provider')) {
    return 'ERR_PROVIDER_FAILURE';
  }
  return 'ERR_PIPELINE_FAILURE';
}

function extractStatus(record?: Record<string, unknown>): number | undefined {
  if (!record) {
    return undefined;
  }
  const candidate = record.status;
  return typeof candidate === 'number' ? candidate : undefined;
}

function extractRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object') {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function normalizeError(error: unknown): ErrorWithMetadata {
  if (error instanceof Error) {
    return error as ErrorWithMetadata;
  }
  return new Error(typeof error === 'string' ? error : 'Unknown error') as ErrorWithMetadata;
}
