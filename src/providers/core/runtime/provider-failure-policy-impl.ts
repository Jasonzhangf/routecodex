/**
 * Provider failure policy implementation.
 * Orchestrates classification / action plan blocks as the app-layer truth.
 */

import type {
  ProviderFailureClassification,
  ProviderFailureRateLimitKind,
  ProviderFailureRetryAction,
  ProviderFailureAction,
  ProviderFailureBackoffScope,
  ProviderFailureDecisionLabel,
  ProviderFailureBackoffPlan,
  ProviderFailureActionPlan,
  ProviderFailureRetryEligibilityPlan,
  ProviderFailureOutcome,
  ProviderFailureExclusionDecision,
  ProviderFailureStage,
} from './provider-failure-policy.js';
import { loadNativeFailurePolicyBridge } from './provider-failure-policy-native.js';
import {
  computeProviderFailureBackoffDelayMsBlock,
  resolveProviderFailureBackoffPlanBlock
} from './provider-failure-policy-backoff.js';

const UNRECOVERABLE_CODE_SET = new Set([
  'INVALID_API_KEY',
  'INVALID_ACCESS_TOKEN',
  'INSUFFICIENT_QUOTA',
  'MODEL_NOT_SUPPORTED',
  'MODEL_DISABLED',
  'NO_SUCH_MODEL',
  'ACCOUNT_DISABLED',
  'ACCOUNT_SUSPENDED',
  'ACCESS_DENIED',
  'FORBIDDEN',
  'DEEPSEEK_SESSION_CREATE_FAILED',
  'DEEPSEEK_FILE_UPLOAD_FAILED'
]);

const NETWORK_ERROR_CODE_SET = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'ETIMEDOUT',
  'ECONNABORTED'
]);

const BLOCKING_RECOVERABLE_CODE_SET = new Set([
  'PROVIDER_TRAFFIC_SATURATED',
  'HTTP_429',
  'HTTP_500',
  'HTTP_502',
  'HTTP_503',
  'HTTP_504',
  'SSE_TO_JSON_ERROR',
  'SSE_DECODE_ERROR',
  'UPSTREAM_EMPTY_OUTPUT'
]);

function isHostFailureStage(stage?: string): boolean {
  return stage === 'host.response_contract' || stage === 'host.stopless_contract';
}

export function normalizeProviderFailureCodeKey(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed.toUpperCase() : undefined;
}

export function isProviderFailureClientDisconnect(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const err = error as { code?: unknown; message?: unknown; name?: unknown; cause?: unknown };
  const code = normalizeProviderFailureCodeKey(err.code);
  if (code === 'CLIENT_DISCONNECTED') {
    return true;
  }
  const message = typeof err.message === 'string' ? err.message.toLowerCase() : '';
  if (message.includes('client_disconnected') || message.includes('client disconnected')) {
    return true;
  }
  if (
    err.name === 'AbortError'
    && (
      message.includes('client_request_aborted')
      || message.includes('client_response_closed')
      || message.includes('client_timeout_hint_expired')
    )
  ) {
    return true;
  }
  const cause = err.cause;
  return cause && cause !== error ? isProviderFailureClientDisconnect(cause) : false;
}

export function isProviderFailureNetworkTransportLike(error: unknown): boolean {
  if (isProviderFailureClientDisconnect(error) || !error || typeof error !== 'object') {
    return false;
  }
  const err = error as { code?: unknown; message?: unknown; name?: unknown };
  const code = normalizeProviderFailureCodeKey(err.code);
  if (code && NETWORK_ERROR_CODE_SET.has(code)) {
    return true;
  }
  const message = typeof err.message === 'string' ? err.message.toLowerCase() : '';
  const name = typeof err.name === 'string' ? err.name : '';
  if (name === 'AbortError' || message.includes('operation was aborted')) {
    return true;
  }
  return [
    'fetch failed',
    'network timeout',
    'socket hang up',
    'client network socket disconnected',
    'tls handshake timeout',
    'unable to verify the first certificate',
    'network error',
    'temporarily unreachable'
  ].some((hint) => message.includes(hint));
}

function isPromptTooLongLike(args: {
  error?: unknown;
  statusCode?: number;
  errorCode?: string;
  upstreamCode?: string;
  reason?: string;
}): boolean {
  if (args.errorCode === 'CONTEXT_LENGTH_EXCEEDED' || args.upstreamCode === 'CONTEXT_LENGTH_EXCEEDED') {
    return true;
  }
  if (typeof args.statusCode === 'number' && args.statusCode !== 400) {
    return false;
  }
  const rawMessage =
    typeof args.reason === 'string' && args.reason.trim()
      ? args.reason
      : (args.error as { message?: unknown } | undefined)?.message;
  const message = typeof rawMessage === 'string' ? rawMessage.toLowerCase() : '';
  return (
    message.includes('prompt is too long')
    || message.includes('maximum context')
    || message.includes('max context')
    || message.includes('context length')
    || message.includes('context window')
    || message.includes('input tokens exceeds')
  );
}

function readNestedProviderErrorDetails(error: unknown): {
  code?: string;
  type?: string;
  param?: string;
  message?: string;
} {
  if (!error || typeof error !== 'object') {
    return {};
  }
  const response = (error as { response?: unknown }).response;
  if (!response || typeof response !== 'object') {
    return {};
  }
  const data = (response as { data?: unknown }).data;
  if (!data || typeof data !== 'object') {
    return {};
  }
  const nested = (data as { error?: unknown }).error;
  if (!nested || typeof nested !== 'object' || Array.isArray(nested)) {
    return {};
  }
  const record = nested as Record<string, unknown>;
  return {
    code: typeof record.code === 'string' ? record.code : undefined,
    type: typeof record.type === 'string' ? record.type : undefined,
    param: typeof record.param === 'string' ? record.param : undefined,
    message: typeof record.message === 'string' ? record.message : undefined
  };
}

export function resolveProviderFailureClassification(args: {
  error: unknown;
  stage?: string;
  statusCode?: number;
  errorCode?: string;
  upstreamCode?: string;
  reason?: string;
  rateLimitKind?: ProviderFailureRateLimitKind;
}): ProviderFailureClassification | undefined {
  if (args.stage === 'provider.followup' || isHostFailureStage(args.stage)) {
    return undefined;
  }
  if (args.rateLimitKind === 'daily_limit') {
    return 'unrecoverable';
  }
  if (args.rateLimitKind === 'synthetic_cooldown') {
    return 'recoverable';
  }
  if (isProviderFailureClientDisconnect(args.error)) {
    return 'unrecoverable';
  }
  const errorCode = normalizeProviderFailureCodeKey(args.errorCode ?? (args.error as { code?: unknown } | undefined)?.code);
  const upstreamCode = normalizeProviderFailureCodeKey(
    args.upstreamCode ?? (args.error as { upstreamCode?: unknown } | undefined)?.upstreamCode
  );
  const statusCode =
    typeof args.statusCode === 'number'
      ? args.statusCode
      : extractProviderFailureStatusCode(args.error);
  const nested = readNestedProviderErrorDetails(args.error);
  const nestedCode = normalizeProviderFailureCodeKey(nested.code);
  const nestedType = normalizeProviderFailureCodeKey(nested.type);
  const nestedParam = typeof nested.param === 'string' ? nested.param.trim().toLowerCase() : '';
  const reason = String(args.reason || (args.error as { message?: unknown } | undefined)?.message || '')
    .trim()
    .toLowerCase();
  const nestedMessage = typeof nested.message === 'string' ? nested.message.toLowerCase() : '';

  if (
    reason.includes('glm business error (514)')
    || errorCode === '514'
    || upstreamCode === '514'
    || nestedCode === '514'
  ) {
    return 'recoverable';
  }

  if (
    errorCode === 'MALFORMED_REQUEST'
    || upstreamCode === 'MALFORMED_REQUEST'
    || nestedCode === 'MALFORMED_REQUEST'
  ) {
    return 'special_400';
  }

  if (
    errorCode === 'CLIENT_TOOL_ARGS_INVALID'
    || upstreamCode === 'CLIENT_TOOL_ARGS_INVALID'
    || nestedCode === 'CLIENT_TOOL_ARGS_INVALID'
  ) {
    return 'special_400';
  }

  if (
    reason.includes('[mimoweb] upstream assistant response was empty')
    || reason.includes('[mimoweb] upstream emitted tool markers but no tool calls could be harvested')
    || reason.includes('[mimoweb] upstream repeated prior tool call after tool_result')
    || reason.includes('[mimoweb] serialized query exceeds empty-safe limit')
  ) {
    return 'special_400';
  }

  if (
    errorCode === 'MALFORMED_RESPONSE'
    || upstreamCode === 'MALFORMED_RESPONSE'
    || nestedCode === 'MALFORMED_RESPONSE'
  ) {
    return 'unrecoverable';
  }

  if (errorCode === 'CONTEXT_LENGTH_EXCEEDED' || upstreamCode === 'CONTEXT_LENGTH_EXCEEDED') {
    return 'special_400';
  }
  if (
    nestedParam.startsWith('tools.')
    || nestedParam.startsWith('messages.')
    || nestedParam.startsWith('input.')
  ) {
    return 'special_400';
  }
  if (
    (nestedType === 'INVALID_REQUEST_ERROR' || String(nestedType).startsWith('INVALID_') || String(nestedCode).startsWith('INVALID_'))
    && !isPromptTooLongLike({ ...args, statusCode, errorCode, upstreamCode, reason: nestedMessage || reason })
  ) {
    return 'special_400';
  }
  if (statusCode === 400 && !isPromptTooLongLike({ ...args, statusCode, errorCode, upstreamCode, reason })) {
    return 'special_400';
  }
  if (
    errorCode === 'INVALID_REQUEST_ERROR'
    || upstreamCode === 'INVALID_REQUEST_ERROR'
    || reason.includes('invalid request payload')
    || reason.includes('signature-invalid')
  ) {
    return 'special_400';
  }
  if (
    typeof statusCode === 'number'
    && (statusCode === 401 || statusCode === 402 || statusCode === 403)
  ) {
    return 'unrecoverable';
  }
  if (
    typeof statusCode === 'number'
    && statusCode === 404
  ) {
    return 'unrecoverable';
  }
  if (
    (errorCode && UNRECOVERABLE_CODE_SET.has(errorCode))
    || (upstreamCode && UNRECOVERABLE_CODE_SET.has(upstreamCode))
  ) {
    return 'unrecoverable';
  }
  if (
    typeof statusCode === 'number'
    && statusCode === 434
    && (
      reason.includes('blocked due to unauthorized requests')
      || reason.includes('access to the current ak has been blocked')
    )
  ) {
    return 'unrecoverable';
  }
  if (
    reason.includes('invalid api key')
    || reason.includes('invalid access token')
    || reason.includes('token expired')
    || reason.includes('insufficient_quota')
    || reason.includes('quota exceeded')
    || reason.includes('model is not supported')
    || reason.includes('model not supported')
    || reason.includes('access denied')
    || reason.includes('account suspended')
    || reason.includes('account disabled')
    || reason.includes('blocked due to unauthorized requests')
  ) {
    return 'unrecoverable';
  }

  // Final fallback: consume native Rust failure_policy for generic classification
  try {
    const isNetworkError = isProviderFailureNetworkTransportLike(args.error);
    const nativeMod = loadNativeFailurePolicyBridge();
    if (nativeMod?.classifyProviderFailure) {
      const nativeResult = nativeMod.classifyProviderFailure(statusCode, errorCode, upstreamCode, isNetworkError);
      if (nativeResult === 'unrecoverable' || nativeResult === 'recoverable' || nativeResult === 'special_400') {
        return nativeResult;
      }
    }
  } catch (_nativeBridgeError) {
    // Native bridge not available; fall through to TS-side default
  }
  return 'recoverable';
}

export function resolveProviderFailureOutcome(args: {
  error: unknown;
  stage?: string;
  statusCode?: number;
  errorCode?: string;
  upstreamCode?: string;
  reason?: string;
  classification?: ProviderFailureClassification;
  rateLimitKind?: ProviderFailureRateLimitKind;
}): ProviderFailureOutcome {
  const classification =
    args.classification
    ?? resolveProviderFailureClassification({
      error: args.error,
      stage: args.stage,
      statusCode: args.statusCode,
      errorCode: args.errorCode,
      upstreamCode: args.upstreamCode,
      reason: args.reason,
      rateLimitKind: args.rateLimitKind
    });
  return {
    classification,
    recoverable: classification === 'recoverable',
    affectsHealth: !isProviderFailureHealthNeutral({
      stage: args.stage,
      error: args.error,
      errorCode: args.errorCode,
      upstreamCode: args.upstreamCode,
      statusCode: args.statusCode,
      classification
    })
  };
}

export function isBlockingRecoverableProviderFailure(args: {
  statusCode?: number;
  errorCode?: string;
  upstreamCode?: string;
  reason?: string;
}): boolean {
  const status = typeof args.statusCode === 'number' ? args.statusCode : undefined;
  const errorCode = normalizeProviderFailureCodeKey(args.errorCode);
  const upstreamCode = normalizeProviderFailureCodeKey(args.upstreamCode);
  const reason = typeof args.reason === 'string' ? args.reason.trim().toLowerCase() : '';

  if (status === 408 || status === 425 || status === 429 || (typeof status === 'number' && status >= 500)) {
    return true;
  }
  if (
    (errorCode && BLOCKING_RECOVERABLE_CODE_SET.has(errorCode))
    || (upstreamCode && BLOCKING_RECOVERABLE_CODE_SET.has(upstreamCode))
  ) {
    return true;
  }
  if (
    reason.includes('fetch failed')
    || reason.includes('building not completed')
    || reason.includes('network')
    || reason.includes('timeout')
    || reason.includes('temporarily unavailable')
  ) {
    return true;
  }
  return false;
}

export function describeProviderFailureDecision(args: {
  action: ProviderFailureAction;
  backoffScope: Exclude<ProviderFailureBackoffScope, 'none'>;
}): Exclude<ProviderFailureDecisionLabel, 'direct_return'> {
  if (args.action === 'reroute_explicit_alternative') {
    if (args.backoffScope === 'provider') {
      return 'provider_backoff_then_reroute';
    }
    if (args.backoffScope === 'recoverable') {
      return 'recoverable_backoff_then_reroute';
    }
    return 'attempt_backoff_then_reroute';
  }
  if (args.backoffScope === 'provider') {
    return 'provider_backoff_same_provider';
  }
  if (args.backoffScope === 'recoverable') {
    return 'recoverable_backoff_same_provider';
  }
  return 'attempt_backoff_same_provider';
}

export function resolveProviderFailureBackoffPlan(args: {
  scope: ProviderFailureBackoffScope;
  error?: unknown;
  statusCode?: number;
}): ProviderFailureBackoffPlan {
  return resolveProviderFailureBackoffPlanBlock(args);
}

export function computeProviderFailureBackoffDelayMs(args: {
  scope: Exclude<ProviderFailureBackoffScope, 'none'>;
  error?: unknown;
  statusCode?: number;
  attempt?: number;
  consecutive?: number;
}): number {
  return computeProviderFailureBackoffDelayMsBlock(args);
}

export function resolveProviderFailureActionPlan(args: {
  error: unknown;
  stage?: string;
  statusCode?: number;
  errorCode?: string;
  upstreamCode?: string;
  reason?: string;
  classification?: ProviderFailureClassification;
  rateLimitKind?: ProviderFailureRateLimitKind;
  attempt?: number;
  maxAttempts?: number;
  promptTooLong?: boolean;
  forceProviderScopedBackoff?: boolean;
  forceAttemptScopedBackoff?: boolean;
  retryAction?: ProviderFailureRetryAction;
}): ProviderFailureActionPlan {
  const classification =
    args.classification
    ?? resolveProviderFailureClassification({
      error: args.error,
      stage: args.stage,
      statusCode: args.statusCode,
      errorCode: args.errorCode,
      upstreamCode: args.upstreamCode,
      reason: args.reason,
      rateLimitKind: args.rateLimitKind
    });
  const affectsHealth = !isProviderFailureHealthNeutral({
    stage: args.stage,
    error: args.error,
    errorCode: args.errorCode,
    upstreamCode: args.upstreamCode,
    statusCode: args.statusCode,
    classification
  });
  const blockingRecoverable =
    classification === 'recoverable'
      && isBlockingRecoverableProviderFailure({
        statusCode: args.statusCode,
        errorCode: args.errorCode,
        upstreamCode: args.upstreamCode,
        reason: args.reason
      });
  const hasAttemptsBudget =
    typeof args.maxAttempts === 'number' && Number.isFinite(args.maxAttempts)
      ? (typeof args.attempt === 'number' && Number.isFinite(args.attempt)
        ? args.attempt < args.maxAttempts
        : args.maxAttempts > 0)
      : true;

  if (
    classification !== 'recoverable'
    || args.promptTooLong
    || (!hasAttemptsBudget && !blockingRecoverable)
  ) {
    return {
      classification,
      affectsHealth,
      blockingRecoverable: false,
      shouldRetry: false,
      action: 'direct_return',
      backoff: resolveProviderFailureBackoffPlan({ scope: 'none' }),
      decisionLabel: 'direct_return'
    };
  }

  const action = args.retryAction ?? 'retry_same_provider';
  const backoffScope =
    args.forceAttemptScopedBackoff
      ? 'attempt'
      : args.forceProviderScopedBackoff
        ? 'provider'
        : blockingRecoverable
          ? 'recoverable'
          : 'attempt';

  return {
    classification,
    affectsHealth,
    blockingRecoverable,
    shouldRetry: true,
    action,
    backoff: resolveProviderFailureBackoffPlan({
      scope: backoffScope,
      error: args.error,
      statusCode: args.statusCode
    }),
    decisionLabel: describeProviderFailureDecision({
      action,
      backoffScope
    })
  };
}

export function resolveProviderFailureRetryEligibility(args: {
  error: unknown;
  stage?: string;
  statusCode?: number;
  errorCode?: string;
  upstreamCode?: string;
  reason?: string;
  classification?: ProviderFailureClassification;
  rateLimitKind?: ProviderFailureRateLimitKind;
  attempt: number;
  maxAttempts: number;
  promptTooLong?: boolean;
  contextOverflowRetries?: number;
  maxContextOverflowRetries?: number;
  shouldRetryByError?: boolean;
  allowNonPolicyRetry?: boolean;
  stageOutsideProviderFailurePolicy?: boolean;
}): ProviderFailureRetryEligibilityPlan {
  const actionPlan = resolveProviderFailureActionPlan({
    error: args.error,
    stage: args.stage,
    statusCode: args.statusCode,
    errorCode: args.errorCode,
    upstreamCode: args.upstreamCode,
    reason: args.reason,
    classification: args.classification,
    rateLimitKind: args.rateLimitKind,
    attempt: args.attempt,
    maxAttempts: args.maxAttempts,
    promptTooLong: args.promptTooLong
  });
  const blockingRecoverable = actionPlan.blockingRecoverable;

  if (args.stage === 'provider.followup') {
    return {
      classification: actionPlan.classification,
      blockingRecoverable,
      shouldRetry: false
    };
  }
  if (args.stageOutsideProviderFailurePolicy) {
    return {
      classification: actionPlan.classification,
      blockingRecoverable,
      shouldRetry: false
    };
  }
  if (args.promptTooLong) {
    return {
      classification: actionPlan.classification,
      blockingRecoverable: false,
      shouldRetry:
        (args.contextOverflowRetries ?? 0) <= (args.maxContextOverflowRetries ?? 1)
    };
  }
  if (actionPlan.classification === 'special_400') {
    return {
      classification: actionPlan.classification,
      blockingRecoverable: false,
      shouldRetry: false
    };
  }
  if (actionPlan.classification === 'unrecoverable') {
    return {
      classification: actionPlan.classification,
      blockingRecoverable: false,
      shouldRetry: false
    };
  }
  if (blockingRecoverable) {
    return {
      classification: actionPlan.classification,
      blockingRecoverable,
      shouldRetry: actionPlan.shouldRetry
    };
  }
  if (!(args.attempt < args.maxAttempts)) {
    return {
      classification: actionPlan.classification,
      blockingRecoverable,
      shouldRetry: false
    };
  }
  return {
    classification: actionPlan.classification,
    blockingRecoverable,
    shouldRetry: actionPlan.shouldRetry || Boolean(args.allowNonPolicyRetry)
  };
}

export function resolveProviderFailureExclusionDecision(args: {
  promptTooLong?: boolean;
  classification?: ProviderFailureClassification;
  isProviderTrafficSaturated?: boolean;
  isNetworkTransport?: boolean;
  hasAlternativeCandidate: boolean;
  is429?: boolean;
  isVerify?: boolean;
  isReauth?: boolean;
}): ProviderFailureExclusionDecision {
  if (args.promptTooLong) {
    return {
      excludeCurrentProvider: true,
      retryAction: 'reroute_explicit_alternative'
    };
  }
  if (args.classification === 'recoverable') {
    return {
      excludeCurrentProvider: false,
      retryAction: 'retry_same_provider'
    };
  }
  if (args.isProviderTrafficSaturated || args.isNetworkTransport) {
    return {
      excludeCurrentProvider: false,
      retryAction: 'retry_same_provider'
    };
  }
  if (!args.hasAlternativeCandidate) {
    return {
      excludeCurrentProvider: false,
      retryAction: 'retry_same_provider'
    };
  }
  if (args.isVerify || args.is429 || args.isReauth) {
    return {
      excludeCurrentProvider: true,
      retryAction: 'reroute_explicit_alternative'
    };
  }
  return {
    excludeCurrentProvider: true,
    retryAction: 'reroute_explicit_alternative'
  };
}

export function isProviderFailureHealthNeutral(args: {
  stage?: string;
  error?: unknown;
  errorCode?: string;
  upstreamCode?: string;
  statusCode?: number;
  classification?: ProviderFailureClassification;
}): boolean {
  if (args.stage === 'provider.followup' || isHostFailureStage(args.stage)) {
    return true;
  }
  if (args.classification === 'special_400' || args.classification === 'recoverable') {
    return true;
  }
  const errorCode = normalizeProviderFailureCodeKey(args.errorCode);
  const upstreamCode = normalizeProviderFailureCodeKey(args.upstreamCode);
  if (errorCode === 'CLIENT_DISCONNECTED' || upstreamCode === 'CLIENT_DISCONNECTED') {
    return true;
  }
  if (errorCode === 'PROVIDER_TRAFFIC_SATURATED' || upstreamCode === 'PROVIDER_TRAFFIC_SATURATED') {
    return true;
  }
  if (errorCode === 'CLIENT_TOOL_ARGS_INVALID') {
    return true;
  }
  if (upstreamCode === 'CLIENT_INJECT_FAILED') {
    return true;
  }
  if (isProviderFailureNetworkTransportLike(args.error)) {
    return true;
  }
  return false;
}

export function extractProviderFailureStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }
  const err = error as {
    statusCode?: unknown;
    status?: unknown;
    response?: unknown;
    message?: unknown;
  };
  if (typeof err.statusCode === 'number') {
    return err.statusCode;
  }
  if (typeof err.status === 'number') {
    return err.status;
  }
  const response = err.response as Record<string, unknown> | undefined;
  const directStatus = parseStatusCandidate(response?.status);
  const directStatusCode = parseStatusCandidate((response as { statusCode?: unknown } | undefined)?.statusCode);
  const nestedStatus = parseStatusCandidate((response as { data?: Record<string, unknown> } | undefined)?.data?.status);
  const nestedErrorStatus = parseStatusCandidate(
    (response as { data?: { error?: { status?: unknown } } } | undefined)?.data?.error?.status
  );
  const nestedUpstreamStatus = parseStatusCandidate(
    (response as { data?: { upstream?: { status?: unknown } } } | undefined)?.data?.upstream?.status
  );
  const resolved = [nestedUpstreamStatus, nestedErrorStatus, nestedStatus, directStatus, directStatusCode].find(
    (candidate): candidate is number => typeof candidate === 'number' && Number.isFinite(candidate)
  );
  if (typeof resolved === 'number') {
    return resolved;
  }
  if (typeof err.message === 'string') {
    const match = err.message.match(/HTTP\s+(\d{3})/i);
    if (match) {
      const parsed = Number.parseInt(match[1], 10);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

function parseStatusCandidate(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d{3}$/.test(trimmed)) {
      const parsed = Number.parseInt(trimmed, 10);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}
