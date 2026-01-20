import type { ErrorContext } from 'rcc-errorhandling';
import type { ModuleDependencies } from '../../../modules/pipeline/interfaces/pipeline-interfaces.js';
import type { ProviderContext } from '../api/provider-types.js';
import type { TargetMetadata } from '../../../modules/pipeline/orchestrator/pipeline-context.js';
import { formatErrorForErrorCenter } from '../../../utils/error-center-payload.js';
import { getRouteErrorHub, reportRouteError } from '../../../error-handling/route-error-hub.js';
import { buildInfo } from '../../../build-info.js';
import { getProviderErrorCenter } from '../../../modules/llmswitch/bridge.js';
import type { ProviderErrorEvent } from '../../../modules/llmswitch/bridge.js';

type ProviderErrorRuntimeMetadata = ProviderErrorEvent['runtime'];

const providerErrorCenter = (await getProviderErrorCenter())!;

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
  /**
   * 粗粒度错误类别：EXTERNAL_ERROR / TOOL_ERROR / INTERNAL_ERROR。
   * 当错误来自 llmswitch-core 的 ProviderProtocolError 时会自动携带。
   */
  category?: string;
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
  const code = normalizeCode(err, options.stage);
  const status = determineStatusCode(err, options.statusCode);
  const recoverable = options.recoverable ?? (err.retryable === true);

  // 组装细粒度 details：优先使用错误自身的 details，再叠加调用方附加信息。
  let mergedDetails: Record<string, unknown> | undefined = extractRecord(err.details);
  if (options.details) {
    mergedDetails = { ...(mergedDetails ?? {}), ...options.details };
  }
  // 若错误来自 llmswitch-core 的 ProviderProtocolError，则把 coarse 与 fine-grain 信息填入 details，便于统计。
  const categoryRaw = typeof err.category === 'string' && err.category.trim().length ? err.category.trim() : undefined;
  if (categoryRaw) {
    mergedDetails = {
      ...(mergedDetails ?? {}),
      errorCategory: categoryRaw.toUpperCase()
    };
  }
  if (typeof err.code === 'string' && err.code.trim().length) {
    mergedDetails = {
      ...(mergedDetails ?? {}),
      protocolErrorCode: err.code.toUpperCase()
    };
  }

  const event: ProviderErrorEventExtended = {
    code,
    message: err.message || code,
    stage: options.stage,
    status,
    recoverable,
    runtime: options.runtime,
    timestamp: Date.now(),
    details: mergedDetails
  };
  // Default health impact: all errors affect health unless explicitly disabled.
  // For non-recoverable errors (including 402) we always want health impact.
  if (!recoverable) {
    event.affectsHealth = true;
  } else {
    event.affectsHealth = options.affectsHealth !== false;
  }
  // Propagate recoverable flag back to original error for callers that want
  // to implement custom retry/failover behaviour.
  if (typeof recoverable === 'boolean') {
    (err as ErrorWithMetadata).retryable = recoverable;
  }
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
        details: mergedDetails
      },
      originalError: err
    }).catch(reportError => {
      // release 模式下避免在控制台输出完整错误对象，防止 raw 等大字段刷屏。
      if (buildInfo.mode !== 'release') {
        console.error(
          '[provider-error-reporter] failed to route provider error via hub',
          reportError instanceof Error ? reportError.message : String(reportError ?? 'Unknown error')
        );
      }
    });
  } else if (center?.handleError) {
    const severity: ErrorContext['severity'] = status && status >= 500 ? 'high' : 'medium';
    const targetModel =
      options.runtime.target && typeof options.runtime.target === 'object'
        ? (options.runtime.target as { clientModelId?: string }).clientModelId
        : undefined;
    const sanitizedContext = formatErrorForErrorCenter({
      requestId: options.runtime.requestId,
      providerKey: options.runtime.providerKey,
      model: targetModel,
      providerType: options.runtime.providerType,
      providerFamily: options.runtime.providerFamily,
      routeName: options.runtime.routeName,
      status,
      code,
      runtime: options.runtime,
      details: mergedDetails
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
      if (buildInfo.mode !== 'release') {
        console.error(
          '[provider-error-reporter] error center handleError failed',
          handlerError instanceof Error ? handlerError.message : String(handlerError ?? 'Unknown error')
        );
      }
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

function normalizeCode(error: ErrorWithMetadata, stage: string): string {
  // 若错误带有 coarse-grain category，则优先作为统一 code 上报：
  // EXTERNAL_ERROR / TOOL_ERROR / INTERNAL_ERROR。
  const categoryRaw = typeof error.category === 'string' ? error.category.trim() : '';
  if (categoryRaw) {
    return categoryRaw.toUpperCase();
  }

  const rawCode = error.code;
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
