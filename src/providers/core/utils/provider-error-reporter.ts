import type { ModuleDependencies } from '../../../modules/pipeline/interfaces/pipeline-interfaces.js';
import type { ProviderContext } from '../api/provider-types.js';
import type { TargetMetadata } from '../../../modules/pipeline/orchestrator/pipeline-context.js';
import {
  reportProviderErrorToRouterPolicy,
  reportProviderSuccessToRouterPolicy
} from '../../../modules/llmswitch/bridge.js';
import type { ProviderErrorEvent, ProviderSuccessEvent } from '../../../modules/llmswitch/bridge.js';

export const ERROR_PIPELINE_CONTRACT_FEATURE_ID = 'feature_id: error.pipeline_contract';

type ProviderErrorRuntimeMetadata = ProviderErrorEvent['runtime'];

type ExtendedRuntimeMetadata = ProviderErrorRuntimeMetadata & {
  providerFamily?: string;
  runtimeKey?: string;
  consecutiveErrors?: number;
};

type ProviderErrorEventExtended = ProviderErrorEvent & {
  affectsHealth?: boolean;
  fatal?: boolean;
  cooldownOverrideMs?: number;
  quotaScope?: string;
  quotaReason?: string;
  resetAt?: string;
  errorClassification?: 'recoverable' | 'unrecoverable' | 'special_400' | string;
  routePool?: string[];
  excludedProviderKeys?: string[];
};

type ErrorWithMetadata = Error & {
  code?: string;
  status?: number;
  statusCode?: number;
  retryable?: boolean;
  rateLimitKind?: string;
  cooldownOverrideMs?: number;
  quotaScope?: string;
  quotaReason?: string;
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
  recoverable: boolean;
  affectsHealth: boolean;
  routePool?: string[];
  excludedProviderKeys?: string[];
  details?: Record<string, unknown>;
}

export type ErrorErr01SourceRaised = EmitOptions;
export type ErrorErr02HostCaptured = ProviderErrorEventExtended;

const PROVIDER_ERROR_REPORTED_MARKER = '__routecodexProviderErrorReported';

function buildProviderErrorEvent(options: EmitOptions): ProviderErrorEventExtended {
  const err = normalizeError(options.error);
  const code = normalizeCode(err, options.stage);
  const status = determineStatusCode(err, options.statusCode);
  if (typeof options.recoverable !== 'boolean' || typeof options.affectsHealth !== 'boolean') {
    throw new Error('[provider-error-reporter] explicit recoverable/affectsHealth is required');
  }
  const recoverable = options.recoverable;

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
  if (typeof err.rateLimitKind === 'string' && err.rateLimitKind.trim().length) {
    mergedDetails = {
      ...(mergedDetails ?? {}),
      rateLimitKind: err.rateLimitKind.trim()
    };
  }
  if (typeof err.cooldownOverrideMs === 'number' && Number.isFinite(err.cooldownOverrideMs) && err.cooldownOverrideMs > 0) {
    mergedDetails = {
      ...(mergedDetails ?? {}),
      cooldownOverrideMs: err.cooldownOverrideMs
    };
  }
  if (typeof err.quotaScope === 'string' && err.quotaScope.trim().length) {
    mergedDetails = {
      ...(mergedDetails ?? {}),
      quotaScope: err.quotaScope.trim()
    };
  }
  if (typeof err.quotaReason === 'string' && err.quotaReason.trim().length) {
    mergedDetails = {
      ...(mergedDetails ?? {}),
      quotaReason: err.quotaReason.trim()
    };
  }
  
  if (status !== undefined) {
    mergedDetails = { ...(mergedDetails ?? {}), statusCode: status };
  }

  const resetAt = (() => {
    if (typeof (mergedDetails as Record<string, unknown> | undefined)?.resetAt === 'string') {
      const value = String((mergedDetails as Record<string, unknown>).resetAt).trim();
      if (value) return value;
    }
    return undefined;
  })();
  const errorClassification = (() => {
    const raw = typeof (mergedDetails as Record<string, unknown> | undefined)?.errorClassification === 'string'
      ? String((mergedDetails as Record<string, unknown>).errorClassification).trim()
      : '';
    return raw || undefined;
  })();
  const cooldownOverrideMs = typeof err.cooldownOverrideMs === 'number' && Number.isFinite(err.cooldownOverrideMs) && err.cooldownOverrideMs > 0
    ? err.cooldownOverrideMs
    : undefined;
  const quotaScope = typeof err.quotaScope === 'string' && err.quotaScope.trim().length ? err.quotaScope.trim() : undefined;
  const quotaReason = typeof err.quotaReason === 'string' && err.quotaReason.trim().length ? err.quotaReason.trim() : undefined;

  const event: ProviderErrorEventExtended = {
    code,
    message: err.message || code,
    stage: options.stage,
    status,
    recoverable,
    fatal: recoverable ? false : true,
    cooldownOverrideMs,
    quotaScope,
    quotaReason,
    resetAt,
    errorClassification,
    runtime: options.runtime,
    timestamp: Date.now(),
    details: mergedDetails
  };
  event.affectsHealth = options.affectsHealth;
  if (Array.isArray(options.routePool) && options.routePool.length > 0) {
    event.routePool = options.routePool;
  }
  if (Array.isArray(options.excludedProviderKeys) && options.excludedProviderKeys.length > 0) {
    event.excludedProviderKeys = options.excludedProviderKeys;
  }
  // Propagate recoverable flag back to original error for callers that want
  // to implement custom retry/failover behaviour.
  if (typeof recoverable === 'boolean') {
    (err as ErrorWithMetadata).retryable = recoverable;
  }
  return event;
}

function hasProviderErrorReportedMarker(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === 'object'
    && (error as Record<string, unknown>)[PROVIDER_ERROR_REPORTED_MARKER] === true
  );
}

function markProviderErrorReported(error: unknown): void {
  if (!error || typeof error !== 'object') {
    return;
  }
  (error as Record<string, unknown>)[PROVIDER_ERROR_REPORTED_MARKER] = true;
}

export function capture_error_err_02_host_from_error_err_01_source(
  source: ErrorErr01SourceRaised
): ErrorErr02HostCaptured | null {
  if (hasProviderErrorReportedMarker(source.error)) {
    return null;
  }
  const event = buildProviderErrorEvent(source);
  markProviderErrorReported(source.error);
  return event;
}

export async function report_error_err_02_host_to_router_policy_from_error_err_01_source(
  source: ErrorErr01SourceRaised
): Promise<void> {
  const event = capture_error_err_02_host_from_error_err_01_source(source);
  if (!event) {
    return;
  }
  await reportProviderErrorToRouterPolicy(event);
}

export function emitProviderError(options: EmitOptions): void {
  const event = capture_error_err_02_host_from_error_err_01_source(options);
  if (!event) {
    return;
  }
  void reportProviderErrorToRouterPolicy(event).catch((emitError) => {
    console.error('[provider-error-reporter] failed to report provider error to router policy', emitError);
  });
}

export async function emitProviderErrorAndWait(options: EmitOptions): Promise<void> {
  await report_error_err_02_host_to_router_policy_from_error_err_01_source(options);
}

export async function emitProviderSuccessAndWait(runtime: ExtendedRuntimeMetadata): Promise<void> {
  const event: ProviderSuccessEvent = {
    runtime,
    timestamp: Date.now()
  };
  await reportProviderSuccessToRouterPolicy(event);
}

export function buildRuntimeFromProviderContext(ctx: ProviderContext): ExtendedRuntimeMetadata {
  const rtMeta = ctx.runtimeMetadata?.metadata && typeof ctx.runtimeMetadata.metadata === 'object'
    ? (ctx.runtimeMetadata.metadata as Record<string, unknown>)
    : undefined;
  const rtHints = rtMeta?.__rt && typeof rtMeta.__rt === 'object' && !Array.isArray(rtMeta.__rt)
    ? (rtMeta.__rt as Record<string, unknown>)
    : undefined;
  const sessionDir = typeof rtHints?.sessionDir === 'string' && rtHints.sessionDir.trim()
    ? rtHints.sessionDir.trim()
    : undefined;
  const rccUserDir = typeof rtHints?.rccUserDir === 'string' && rtHints.rccUserDir.trim()
    ? rtHints.rccUserDir.trim()
    : undefined;
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
    runtimeKey: ctx.runtimeMetadata?.runtimeKey ?? ctx.target?.runtimeKey,
    ...(sessionDir ? { sessionDir } : {}),
    ...(rccUserDir ? { rccUserDir } : {})
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
  const upstreamCode = extractUpstreamCode(error);
  if (upstreamCode) {
    return upstreamCode.toUpperCase();
  }
  const status = extractStatusForCode(error);
  if (typeof status === 'number' && Number.isFinite(status)) {
    return `HTTP_${Math.floor(status)}`;
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

function extractUpstreamCode(error: ErrorWithMetadata): string | undefined {
  const details = error.details;
  if (details && typeof details === 'object' && !Array.isArray(details)) {
    const code = (details as Record<string, unknown>).upstreamCode;
    if (typeof code === 'string' && code.trim()) {
      return code.trim();
    }
  }
  const response = error.response;
  if (response && typeof response === 'object') {
    const data = (response as { data?: unknown }).data;
    if (data && typeof data === 'object') {
      const err = (data as { error?: unknown }).error;
      if (err && typeof err === 'object') {
        const code = (err as { code?: unknown }).code;
        if (typeof code === 'string' && code.trim()) {
          return code.trim();
        }
      }
    }
  }
  return undefined;
}

function extractStatusForCode(error: ErrorWithMetadata): number | undefined {
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
  const match = typeof error.message === 'string' ? error.message.match(/HTTP\\s+(\\d{3})/) : null;
  if (match) {
    return Number(match[1]);
  }
  return undefined;
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
