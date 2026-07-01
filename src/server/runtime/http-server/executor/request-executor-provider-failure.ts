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
  ReportRequestExecutorProviderErrorArgs,
  RequestExecutorProviderErrorClassification,
  RequestExecutorProviderErrorReportPlan,
  RequestExecutorProviderErrorStage,
  RetryErrorSnapshot
} from './request-executor-error-types.js';
import { emitProviderErrorAndWait } from '../../../../providers/core/utils/provider-error-reporter.js';
import {
  resolveProviderFailureOutcome
} from '../../../../providers/core/runtime/provider-failure-policy.js';
import {
  cloneErrorForReporting
} from './request-executor-error-report.js';

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

export async function reportRequestExecutorProviderError(
  args: ReportRequestExecutorProviderErrorArgs
): Promise<void> {
  const reportPlan = resolveRequestExecutorProviderErrorReportPlan({
    error: args.error,
    retryError: args.retryError,
    stage: args.stageHint ?? 'provider.send'
  });
  const reportOutcome = resolveProviderFailureOutcome({
    error: args.error,
    stage: reportPlan.stageHint,
    statusCode: reportPlan.statusCode,
    errorCode: reportPlan.errorCode,
    upstreamCode: reportPlan.upstreamCode,
    reason: args.retryError.reason
  });
  const rtHints = args.metadata?.__rt && typeof args.metadata.__rt === 'object' && !Array.isArray(args.metadata.__rt)
    ? (args.metadata.__rt as Record<string, unknown>)
    : undefined;
  const sessionDir = typeof rtHints?.sessionDir === 'string' && rtHints.sessionDir.trim()
    ? rtHints.sessionDir.trim()
    : undefined;
  const rccUserDir = typeof rtHints?.rccUserDir === 'string' && rtHints.rccUserDir.trim()
    ? rtHints.rccUserDir.trim()
    : undefined;
  const routecodexRoutingPolicyGroup =
    typeof args.routecodexRoutingPolicyGroup === 'string' && args.routecodexRoutingPolicyGroup.trim()
      ? args.routecodexRoutingPolicyGroup.trim()
      : typeof args.metadata?.routecodexRoutingPolicyGroup === 'string' && args.metadata.routecodexRoutingPolicyGroup.trim()
      ? args.metadata.routecodexRoutingPolicyGroup.trim()
      : undefined;
  await emitProviderErrorAndWait({
    error: cloneErrorForReporting(args.error),
    stage: reportPlan.stageHint,
    runtime: {
      requestId: args.requestId,
      providerKey: args.providerKey,
      providerId: args.providerId,
      providerType: args.providerType,
      providerFamily: args.providerFamily,
      providerProtocol: args.providerProtocol,
      routeName: args.routeName,
      ...(routecodexRoutingPolicyGroup ? { routecodexRoutingPolicyGroup } : {}),
      pipelineId: args.providerKey,
      target: args.target,
      runtimeKey: args.runtimeKey,
      ...(sessionDir ? { sessionDir } : {}),
      ...(rccUserDir ? { rccUserDir } : {})
    },
    dependencies: args.dependencies,
    statusCode: reportPlan.statusCode,
    recoverable: reportOutcome.recoverable,
    affectsHealth: reportOutcome.affectsHealth,
    routePool: args.routePool,
    excludedProviderKeys: args.excludedProviderKeys
      ? Array.from(args.excludedProviderKeys)
      : undefined,
    details: {
      source: reportPlan.stageHint,
      ...(reportOutcome.classification ? { errorClassification: reportOutcome.classification } : {}),
      ...(reportPlan.errorCode ? { errorCode: reportPlan.errorCode } : {}),
      ...(reportPlan.upstreamCode ? { upstreamCode: reportPlan.upstreamCode } : {}),
      reason: args.retryError.reason,
      attempt: args.attempt,
      ...(args.extraDetails ?? {})
    }
  });
}
