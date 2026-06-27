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
import type {
  RequestExecutorProviderErrorClassification,
  RequestExecutorProviderErrorReportPlan,
  RequestExecutorProviderErrorStage,
  RetryErrorSnapshot
} from './request-executor-error-types.js';

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
    ?? normalizeCodeKey(
      (() => {
        if (!args.error || typeof args.error !== 'object' || Array.isArray(args.error)) {
          return undefined;
        }
        const details = (args.error as { details?: unknown }).details;
        if (!details || typeof details !== 'object' || Array.isArray(details)) {
          return undefined;
        }
        const upstreamCode = (details as { upstreamCode?: unknown }).upstreamCode;
        return typeof upstreamCode === 'string' && upstreamCode.trim() ? upstreamCode : undefined;
      })()
    )
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

export {
  isHostRequestExecutorErrorStage,
  isRequestExecutorProviderErrorStage
};
