import type { ModuleDependencies } from '../../../../modules/pipeline/interfaces/pipeline-interfaces.js';
import {
  isBlockingRecoverableProviderFailure,
  isProviderFailureHealthNeutral,
  normalizeProviderFailureCodeKey,
  resolveProviderFailureClassification
} from '../../../../providers/core/runtime/provider-failure-policy.js';
import {
  isSseDecodeRateLimitError,
  isSseDecodeRetryableNetworkError
} from './request-retry-helpers.js';
import {
  extractStatusCodeFromError
} from './utils.js';
import {
  extractRequestExecutorProviderErrorStage,
  isHostRequestExecutorErrorStage,
  isRequestExecutorProviderErrorStage,
  isServerToolFollowupErrorCode,
  normalizeCodeKey
} from './request-executor-error-shared.js';
import { emitProviderErrorAndWait } from '../../../../providers/core/utils/provider-error-reporter.js';
import type {
  ReportRequestExecutorProviderErrorArgs,
  RequestExecutorProviderErrorClassification,
  RequestExecutorProviderErrorReportPlan,
  RequestExecutorProviderErrorStage,
  RetryErrorSnapshot
} from './request-executor-error-types.js';

function extractProviderRateLimitKind(error: unknown): 'synthetic_cooldown' | 'daily_limit' | 'short_lived' | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }
  const record = error as { rateLimitKind?: unknown; details?: unknown };
  const direct = typeof record.rateLimitKind === 'string' ? record.rateLimitKind.trim().toLowerCase() : '';
  if (direct === 'synthetic_cooldown' || direct === 'daily_limit' || direct === 'short_lived') {
    return direct;
  }
  const details =
    record.details && typeof record.details === 'object' && !Array.isArray(record.details)
      ? (record.details as Record<string, unknown>)
      : undefined;
  const nested = typeof details?.rateLimitKind === 'string' ? details.rateLimitKind.trim().toLowerCase() : '';
  if (nested === 'synthetic_cooldown' || nested === 'daily_limit' || nested === 'short_lived') {
    return nested;
  }
  return undefined;
}

function readProviderProtocolErrorDetailUpstreamCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || Array.isArray(error)) {
    return undefined;
  }
  const details = (error as { details?: unknown }).details;
  if (!details || typeof details !== 'object' || Array.isArray(details)) {
    return undefined;
  }
  const upstreamCode = (details as { upstreamCode?: unknown }).upstreamCode;
  return typeof upstreamCode === 'string' && upstreamCode.trim() ? upstreamCode : undefined;
}

export function resolveRequestExecutorProviderErrorClassification(args: {
  error: unknown;
  retryError: RetryErrorSnapshot;
  stage?: RequestExecutorProviderErrorStage;
}): RequestExecutorProviderErrorClassification | undefined {
  return resolveProviderFailureClassification({
    error: args.error,
    stage: args.stage,
    statusCode:
      typeof args.retryError.statusCode === 'number'
        ? args.retryError.statusCode
        : extractStatusCodeFromError(args.error),
    errorCode:
      normalizeProviderFailureCodeKey((args.error as { code?: unknown } | undefined)?.code)
      ?? normalizeProviderFailureCodeKey(args.retryError.errorCode),
    upstreamCode:
      normalizeProviderFailureCodeKey((args.error as { upstreamCode?: unknown } | undefined)?.upstreamCode)
      ?? normalizeProviderFailureCodeKey(args.retryError.upstreamCode),
    reason: String(args.retryError.reason || (args.error as { message?: string } | undefined)?.message || ''),
    rateLimitKind: extractProviderRateLimitKind(args.error)
  });
}

export function shouldApplyProviderTransportBackoff(args: {
  error: unknown;
  retryError: RetryErrorSnapshot;
  stage?: RequestExecutorProviderErrorStage;
}): boolean {
  const stage = args.stage ?? 'provider.send';
  if (stage === 'provider.followup' || isHostRequestExecutorErrorStage(stage)) {
    return false;
  }
  if (isBlockingRecoverableProviderFailure({
    statusCode: args.retryError.statusCode,
    errorCode: args.retryError.errorCode,
    upstreamCode: args.retryError.upstreamCode,
    reason: args.retryError.reason
  })) {
    return true;
  }
  return resolveRequestExecutorProviderErrorClassification({
    error: args.error,
    retryError: args.retryError,
    stage
  }) === 'recoverable';
}

export function resolveRequestExecutorProviderErrorReportPlan(args: {
  error: unknown;
  retryError: RetryErrorSnapshot;
  stage: RequestExecutorProviderErrorStage;
}): RequestExecutorProviderErrorReportPlan {
  const errorCode =
    normalizeCodeKey((args.error as { code?: unknown } | undefined)?.code)
    ?? normalizeCodeKey(args.retryError.errorCode);
  const upstreamCode =
    normalizeCodeKey((args.error as { upstreamCode?: unknown } | undefined)?.upstreamCode)
    ?? normalizeCodeKey(readProviderProtocolErrorDetailUpstreamCode(args.error))
    ?? normalizeCodeKey(args.retryError.upstreamCode);
  const statusCode =
    typeof args.retryError.statusCode === 'number'
      ? args.retryError.statusCode
      : extractStatusCodeFromError(args.error);
  const explicitStage = extractRequestExecutorProviderErrorStage(args.error);
  const stageHint: RequestExecutorProviderErrorStage = explicitStage
    ?? (args.stage === 'provider.runtime_resolve'
      ? 'provider.runtime_resolve'
      : args.stage === 'provider.http'
        ? 'provider.http'
        : args.stage === 'host.response_contract'
          ? 'host.response_contract'
          : (isSseDecodeRateLimitError(args.error, statusCode) || isSseDecodeRetryableNetworkError(args.error, statusCode))
            ? 'provider.sse_decode'
            : (isServerToolFollowupErrorCode(errorCode) || isServerToolFollowupErrorCode(upstreamCode))
              ? 'provider.followup'
              : 'provider.send');
  return {
    ...(errorCode ? { errorCode } : {}),
    ...(upstreamCode ? { upstreamCode } : {}),
    ...(typeof statusCode === 'number' ? { statusCode } : {}),
    stageHint
  };
}

export function isHealthNeutralProviderError(args: {
  stage: RequestExecutorProviderErrorStage;
  error?: unknown;
  errorCode?: string;
  upstreamCode?: string;
  statusCode?: number;
  classification?: RequestExecutorProviderErrorClassification;
}): boolean {
  return isProviderFailureHealthNeutral({
    stage: args.stage,
    error: args.error,
    errorCode: args.errorCode,
    upstreamCode: args.upstreamCode,
    statusCode: args.statusCode,
    classification: args.classification
  });
}

export function resolveReportedProviderErrorRecoverable(args: {
  stage: RequestExecutorProviderErrorStage;
  error: unknown;
  retryError: RetryErrorSnapshot;
}): boolean {
  if (args.stage === 'provider.followup') {
    return false;
  }
  const classification = resolveRequestExecutorProviderErrorClassification({
    error: args.error,
    retryError: args.retryError,
    stage: args.stage
  });
  if (
    !classification
    && isBlockingRecoverableProviderFailure({
      statusCode: args.retryError.statusCode,
      errorCode: args.retryError.errorCode,
      upstreamCode: args.retryError.upstreamCode,
      reason: args.retryError.reason
    })
  ) {
    return true;
  }
  if (classification === 'special_400') {
    return false;
  }
  if (classification === 'unrecoverable') {
    return false;
  }
  if (classification === 'recoverable') {
    return true;
  }
  return false;
}

export async function reportRequestExecutorProviderError(
  args: ReportRequestExecutorProviderErrorArgs
): Promise<void> {
  const reportPlan = resolveRequestExecutorProviderErrorReportPlan({
    error: args.error,
    retryError: args.retryError,
    stage: args.stageHint ?? 'provider.send'
  });
  const errorCode = reportPlan.errorCode;
  const upstreamCode = reportPlan.upstreamCode;
  const statusCode = reportPlan.statusCode;
  const stage = reportPlan.stageHint;
  const classification = resolveRequestExecutorProviderErrorClassification({
    error: args.error,
    retryError: args.retryError,
    stage
  });
  const affectsHealth = !isHealthNeutralProviderError({
    stage,
    error: args.error,
    errorCode,
    upstreamCode,
    statusCode,
    classification
  });
  if (isHostRequestExecutorErrorStage(stage)) {
    args.logStage('host.contract_failure.classified', args.requestId, {
      providerKey: args.providerKey,
      stage,
      ...(typeof statusCode === 'number' ? { statusCode } : {}),
      ...(errorCode ? { errorCode } : {}),
      ...(upstreamCode ? { upstreamCode } : {}),
      reason: args.retryError.reason,
      attempt: args.attempt
    });
  }
  try {
    await emitProviderErrorAndWait({
      error: args.error,
      stage,
      runtime: {
        requestId: args.requestId,
        providerKey: args.providerKey,
        providerId: args.providerId,
        providerType: args.providerType,
        providerFamily: args.providerFamily,
        providerProtocol: args.providerProtocol,
        routeName: args.routeName,
        pipelineId: args.providerKey,
        target: args.target,
        runtimeKey: args.runtimeKey
      },
      dependencies: args.dependencies as ModuleDependencies,
      statusCode,
      recoverable: resolveReportedProviderErrorRecoverable({
        stage,
        error: args.error,
        retryError: args.retryError
      }),
      affectsHealth,
      details: {
        source: stage,
        ...(classification ? { errorClassification: classification } : {}),
        ...(errorCode ? { errorCode } : {}),
        ...(upstreamCode ? { upstreamCode } : {}),
        reason: args.retryError.reason,
        attempt: args.attempt,
        ...(args.extraDetails ?? {})
      }
    });
  } catch (reportError) {
    args.logStage('provider.error_reporter.failed', args.requestId, {
      providerKey: args.providerKey,
      stage,
      ...(typeof statusCode === 'number' ? { statusCode } : {}),
      message: reportError instanceof Error ? reportError.message : String(reportError ?? 'Unknown reporter error'),
      attempt: args.attempt
    });
  }
}

export {
  isHostRequestExecutorErrorStage,
  isRequestExecutorProviderErrorStage
};
