/**
 * feature_id: error.provider_failure_policy
 */
/**
 * Provider failure policy implementation.
 * Orchestrates classification / action plan blocks as the app-layer truth.
 */

import type {
  ProviderFailureClassification,
  ProviderFailureRateLimitKind,
  ProviderFailureRetryAction,
  ProviderFailureAction,
  ProviderFailureDecisionLabel,
  ProviderFailureActionPlan,
  ProviderFailureRetryEligibilityPlan,
  ProviderFailureOutcome,
  ProviderFailureExclusionDecision,
  ProviderFailureStage,
} from './provider-failure-policy.js';
import type { ErrorErr02HostCaptured } from '../utils/provider-error-reporter.js';
import { loadNativeFailurePolicyBridge } from './provider-failure-policy-native.js';
import {
  normalizeKnownProviderError,
  PROVIDER_BLOCKING_RECOVERABLE_CODES,
  PROVIDER_NETWORK_CODES,
  PROVIDER_UNRECOVERABLE_CODES
} from './provider-error-catalog.js';
import { DEEPSEEK_UNRECOVERABLE_CODES } from '../contracts/deepseek-provider-contract.js';



// Phase 2: SSOT composition - provider-agnostic catalog + provider-specific contracts.
const UNRECOVERABLE_CODE_SET: ReadonlySet<string> = new Set<string>([
  ...PROVIDER_UNRECOVERABLE_CODES,
  ...DEEPSEEK_UNRECOVERABLE_CODES
]);
const NETWORK_ERROR_CODE_SET: ReadonlySet<string> = PROVIDER_NETWORK_CODES;
const BLOCKING_RECOVERABLE_CODE_SET: ReadonlySet<string> = new Set<string>([
  ...PROVIDER_BLOCKING_RECOVERABLE_CODES
]);

function isHostFailureStage(stage?: string): boolean {
  return stage === 'host.response_contract';
}

function isRecoverableHostResponseContractCode(code?: string): boolean {
  return code === 'EMPTY_ASSISTANT_RESPONSE' || code === 'MISSING_REQUIRED_TOOL_CALL';
}

function isProviderBusinessStatus2013(value: unknown): boolean {
  if (typeof value === 'number') {
    return value === 2013;
  }
  if (typeof value !== 'string') {
    return false;
  }
  const normalized = value.trim().toUpperCase();
  if (!normalized) {
    return false;
  }
  if (normalized === '2013') {
    return true;
  }
  return /(?:^|_)2013(?:_|$)/.test(normalized);
}

function isProviderBusinessStatus2013ContextOverflow(args: {
  statusCode?: number;
  error?: unknown;
  errorCode?: string;
  upstreamCode?: string;
  reason?: string;
  nestedMessage?: string;
  protocolReason?: string;
  protocolUpstreamCode?: string;
  providerStatusCode?: number;
}): boolean {
  const has2013Signal =
    isProviderBusinessStatus2013(args.errorCode)
    || isProviderBusinessStatus2013(args.upstreamCode)
    || isProviderBusinessStatus2013(args.protocolUpstreamCode)
    || isProviderBusinessStatus2013(args.providerStatusCode);
  if (!has2013Signal) {
    return false;
  }
  if (args.protocolReason === 'context_length_exceeded') {
    return true;
  }
  if ((args.reason ?? '').includes('context_length_exceeded')) {
    return true;
  }
  if ((args.nestedMessage ?? '').includes('context_length_exceeded')) {
    return true;
  }
  return isPromptTooLongLike({
    error: args.error,
    statusCode: args.statusCode,
    errorCode: args.protocolUpstreamCode || args.errorCode,
    upstreamCode: args.protocolUpstreamCode || args.upstreamCode,
    reason: args.protocolReason || args.nestedMessage || args.reason
  });
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
  // Upstream 499 (nginx "Client Closed Request") with a body that signals the
  // end-client closed the request must be treated as a transport cancellation,
  // not a normal upstream 4xx. 4xx 499 must NEVER be a real provider error:
  // no cooldown, no health impact, no error-projection leak to caller.
  const errStatus = (err as { status?: unknown; statusCode?: unknown }).status;
  const errStatusCode = (err as { status?: unknown; statusCode?: unknown }).statusCode;
  const statusLooksLike499 =
    errStatus === 499
    || errStatusCode === 499
    || code === 'HTTP_499'
    || /http\s+499[:\s]/i.test(message);
  if (statusLooksLike499) {
    const bodyHints = [
      message,
      typeof (err as { details?: { upstreamMessage?: unknown } }).details?.upstreamMessage === 'string'
        ? ((err as { details: { upstreamMessage: string } }).details.upstreamMessage).toLowerCase()
        : '',
      typeof (err as { response?: { data?: { error?: { message?: unknown } } } }).response?.data?.error?.message === 'string'
        ? String((err as { response: { data: { error: { message: string } } } }).response.data.error.message).toLowerCase()
        : '',
    ];
    if (bodyHints.some((hint) => hint.includes('client abort request') || hint.includes('client closed request'))) {
      return true;
    }
  }
  if (message.includes('client_disconnected') || message.includes('client disconnected')) {
    return true;
  }
  if (message.includes('client abort request') || message.includes('client closed request')) {
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

function isProviderRuntimeRequestContractError(reason: string): boolean {
  return reason.includes('provider-runtime-error: responses payload missing "input" or "instructions"')
    || reason.includes('provider-runtime-error: responses provider received chat-style "messages"')
    || reason.includes('provider-runtime-error: responses payload must be an object')
    || reason.includes('provider-runtime-error: missing model from direct passthrough responses payload');
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

function readProviderProtocolErrorDetails(error: unknown): {
  reason?: string;
  upstreamCode?: string;
  providerStatusCode?: number;
} {
  if (!error || typeof error !== 'object' || Array.isArray(error)) {
    return {};
  }
  const details = (error as { details?: unknown }).details;
  if (!details || typeof details !== 'object' || Array.isArray(details)) {
    return {};
  }
  const record = details as Record<string, unknown>;
  return {
    reason: typeof record.reason === 'string' ? record.reason : undefined,
    upstreamCode: typeof record.upstreamCode === 'string' ? record.upstreamCode : undefined,
    providerStatusCode: typeof record.providerStatusCode === 'number' ? record.providerStatusCode : undefined
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
  const errorCode = normalizeProviderFailureCodeKey(args.errorCode ?? (args.error as { code?: unknown } | undefined)?.code);
  const upstreamCode = normalizeProviderFailureCodeKey(
    args.upstreamCode ?? (args.error as { upstreamCode?: unknown } | undefined)?.upstreamCode
  );
  if (args.stage === 'provider.followup') {
    return undefined;
  }
  if (isHostFailureStage(args.stage)) {
    if (isRecoverableHostResponseContractCode(errorCode) || isRecoverableHostResponseContractCode(upstreamCode)) {
      return 'recoverable';
    }
    return undefined;
  }
  if (isProviderFailureClientDisconnect(args.error)) {
    return 'unrecoverable';
  }
  const statusCode =
    typeof args.statusCode === 'number'
      ? args.statusCode
      : extractProviderFailureStatusCode(args.error);
  const nested = readNestedProviderErrorDetails(args.error);
  const protocolDetails = readProviderProtocolErrorDetails(args.error);
  const nestedCode = normalizeProviderFailureCodeKey(nested.code);
  const nestedType = normalizeProviderFailureCodeKey(nested.type);
  const nestedParam = typeof nested.param === 'string' ? nested.param.trim().toLowerCase() : '';
  const reason = String(args.reason || (args.error as { message?: unknown } | undefined)?.message || '')
    .trim()
    .toLowerCase();
  const nestedMessage = typeof nested.message === 'string' ? nested.message.toLowerCase() : '';
  const protocolReason = typeof protocolDetails.reason === 'string' ? protocolDetails.reason.trim().toLowerCase() : '';
  const protocolUpstreamCode = normalizeProviderFailureCodeKey(protocolDetails.upstreamCode);
  const has2013Signal =
    isProviderBusinessStatus2013(errorCode)
    || isProviderBusinessStatus2013(upstreamCode)
    || isProviderBusinessStatus2013(nestedCode)
    || isProviderBusinessStatus2013(protocolUpstreamCode)
    || isProviderBusinessStatus2013(protocolDetails.providerStatusCode);
  const isMalformedProviderBusiness2013 =
    (errorCode === 'MALFORMED_RESPONSE' || upstreamCode === 'MALFORMED_RESPONSE' || nestedCode === 'MALFORMED_RESPONSE')
    && (
      protocolUpstreamCode === 'PROVIDER_STATUS_2013'
      || upstreamCode === 'PROVIDER_STATUS_2013'
      || nestedCode === 'PROVIDER_STATUS_2013'
      || protocolDetails.providerStatusCode === 2013
      || isProviderBusinessStatus2013(protocolUpstreamCode)
      || isProviderBusinessStatus2013(upstreamCode)
      || isProviderBusinessStatus2013(nestedCode)
    );

  if (isProviderRuntimeRequestContractError(reason)) {
    return 'special_400';
  }

  if (
    isProviderBusinessStatus2013ContextOverflow({
      error: args.error,
      statusCode,
      errorCode,
      upstreamCode,
      reason,
      nestedMessage,
      protocolReason,
      protocolUpstreamCode,
      providerStatusCode: protocolDetails.providerStatusCode
    })
  ) {
    return 'special_400';
  }

  if (has2013Signal && !isMalformedProviderBusiness2013) {
    return 'special_400';
  }

  if (
    errorCode === 'ERR_HTTP2_STREAM_CANCEL'
    || upstreamCode === 'ERR_HTTP2_STREAM_CANCEL'
    || nestedCode === 'ERR_HTTP2_STREAM_CANCEL'
  ) {
    return 'recoverable';
  }

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
    statusCode === 520
    && (
      upstreamCode === 'PROVIDER_STATUS_1000'
      || nestedCode === 'PROVIDER_STATUS_1000'
      || reason.includes('unknown error, 520')
    )
  ) {
    return 'recoverable';
  }

  if (
    (errorCode === 'MALFORMED_RESPONSE' || upstreamCode === 'MALFORMED_RESPONSE' || nestedCode === 'MALFORMED_RESPONSE')
    && (
      protocolUpstreamCode === 'PROVIDER_STATUS_2056'
      || upstreamCode === 'PROVIDER_STATUS_2056'
      || nestedCode === 'PROVIDER_STATUS_2056'
      || reason.includes('usage limit exceeded')
    )
  ) {
    // 2056 = upstream rotation/overload (MiniMax). Typically transient.
    // Keep as recoverable so the provider retries internally. After 6 attempts,
    // the error is escalated naturally by the retry engine.
    return 'recoverable';
  }

  if (
    (errorCode === 'MALFORMED_RESPONSE' || upstreamCode === 'MALFORMED_RESPONSE' || nestedCode === 'MALFORMED_RESPONSE')
    && (
      protocolUpstreamCode === 'SERVER_ERROR'
      || upstreamCode === 'SERVER_ERROR'
      || nestedCode === 'SERVER_ERROR'
      || nestedType === 'SERVER_ERROR'
    )
  ) {
    return 'recoverable';
  }

  if (
    (errorCode === 'MALFORMED_RESPONSE' || upstreamCode === 'MALFORMED_RESPONSE' || nestedCode === 'MALFORMED_RESPONSE')
    && (
      protocolUpstreamCode === 'PROVIDER_STATUS_2013'
      || upstreamCode === 'PROVIDER_STATUS_2013'
      || nestedCode === 'PROVIDER_STATUS_2013'
      || protocolDetails.providerStatusCode === 2013
      || isProviderBusinessStatus2013(protocolUpstreamCode)
      || isProviderBusinessStatus2013(upstreamCode)
      || isProviderBusinessStatus2013(nestedCode)
    )
    && !isProviderBusinessStatus2013ContextOverflow({
      error: args.error,
      statusCode,
      errorCode,
      upstreamCode,
      reason,
      nestedMessage,
      protocolReason,
      protocolUpstreamCode,
      providerStatusCode: protocolDetails.providerStatusCode
    })
  ) {
    return 'recoverable';
  }

  if (
    statusCode === 200
    && (
      errorCode === 'MALFORMED_RESPONSE'
      || upstreamCode === 'MALFORMED_RESPONSE'
      || nestedCode === 'MALFORMED_RESPONSE'
    )
    && (
      reason.includes('instead of sse')
      || nestedMessage.includes('instead of sse')
      || protocolReason.includes('instead of sse')
    )
  ) {
    return 'recoverable';
  }

  if (
    (errorCode === 'MALFORMED_RESPONSE'
      || upstreamCode === 'MALFORMED_RESPONSE'
      || nestedCode === 'MALFORMED_RESPONSE')
    && (
      protocolReason === 'context_length_exceeded'
      || protocolUpstreamCode === 'CONTEXT_LENGTH_EXCEEDED'
      || protocolDetails.providerStatusCode === 2013
      || reason.includes('context_length_exceeded')
      || nestedMessage.includes('context_length_exceeded')
      || isPromptTooLongLike({
        ...args,
        statusCode,
        errorCode: protocolUpstreamCode || errorCode,
        upstreamCode: protocolUpstreamCode || upstreamCode,
        reason: protocolReason || reason
      })
    )
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

  const known = normalizeKnownProviderError({
    statusCode,
    code: errorCode,
    upstreamCode: protocolUpstreamCode || upstreamCode,
    message: reason,
  });
  if (known?.class === 'unrecoverable') {
    return 'unrecoverable';
  }
  if (known?.class === 'special_400') {
    return 'special_400';
  }
  if (known?.class === 'recoverable') {
    return 'recoverable';
  }

  // Final fallback: consume native Rust failure_policy for generic classification
  try {
    const isNetworkError = isProviderFailureNetworkTransportLike(args.error);
    const nativeMod = loadNativeFailurePolicyBridge();
    if (nativeMod?.classifyProviderFailure) {
      const nativeResult = nativeMod.classifyProviderFailure(statusCode, errorCode, upstreamCode, isNetworkError);
      if (
        nativeResult === 'unrecoverable'
        || nativeResult === 'recoverable'
        || nativeResult === 'special_400'
      ) {
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

export function classify_error_err_03_runtime_from_error_err_02_host(
  captured: ErrorErr02HostCaptured
): ProviderFailureOutcome {
  return resolveProviderFailureOutcome({
    error: {
      message: captured.message,
      code: captured.code,
      status: captured.status,
      statusCode: captured.status,
      upstreamCode: captured.details?.upstreamCode,
      rateLimitKind: captured.details?.rateLimitKind,
    },
    stage: captured.stage,
    statusCode: captured.status,
    errorCode: captured.code,
    upstreamCode: typeof captured.details?.upstreamCode === 'string' ? captured.details.upstreamCode : undefined,
    reason: captured.message,
    classification:
      captured.errorClassification === 'recoverable'
        || captured.errorClassification === 'unrecoverable'
        || captured.errorClassification === 'special_400'
        ? captured.errorClassification
        : undefined,
  });
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
  if (errorCode === 'MALFORMED_RESPONSE' && upstreamCode === 'PROVIDER_STATUS_2013') {
    return true;
  }
  if (errorCode === 'MALFORMED_RESPONSE' && upstreamCode === 'SERVER_ERROR') {
    return true;
  }
  if (
    reason.includes('fetch failed')
    || reason.includes('building not completed')
    || reason.includes('network')
    || reason.includes('timeout')
    || reason.includes('temporarily unavailable')
    || reason.includes('当前请求量较高')
    || reason.includes('请稍后重试')
  ) {
    return true;
  }
  return false;
}

export function describeProviderFailureDecision(args: {
  action: ProviderFailureAction;
}): Exclude<ProviderFailureDecisionLabel, 'direct_return'> {
  if (args.action !== 'reroute_explicit_alternative') {
    throw new Error(`unsupported provider failure retry action: ${String(args.action)}`);
  }
  return 'exclude_and_reroute';
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
      decisionLabel: 'direct_return'
    };
  }

  const action = args.retryAction ?? 'reroute_explicit_alternative';
  return {
    classification,
    affectsHealth,
    blockingRecoverable,
    shouldRetry: true,
    action,
    decisionLabel: describeProviderFailureDecision({
      action
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
  statusCode?: number;
  errorCode?: string;
  upstreamCode?: string;
  isProviderTrafficSaturated?: boolean;
  isNetworkTransport?: boolean;
  hasAlternativeCandidate: boolean;
  is429?: boolean;
  isVerify?: boolean;
  isReauth?: boolean;
}): ProviderFailureExclusionDecision {
  if (!args.hasAlternativeCandidate) {
    return {
      excludeCurrentProvider: false,
      retryAction: 'reroute_explicit_alternative'
    };
  }
  const normalizedErrorCode = normalizeProviderFailureCodeKey(args.errorCode);
  const normalizedUpstreamCode = normalizeProviderFailureCodeKey(args.upstreamCode);
  const isStreamCanceled =
    normalizedErrorCode === 'ERR_HTTP2_STREAM_CANCEL'
    || normalizedUpstreamCode === 'ERR_HTTP2_STREAM_CANCEL';
  if (isStreamCanceled && args.hasAlternativeCandidate) {
    return {
      excludeCurrentProvider: true,
      retryAction: 'reroute_explicit_alternative'
    };
  }
  const isHttp503 =
    args.statusCode === 503
    || normalizedErrorCode === 'HTTP_503'
    || normalizedUpstreamCode === 'HTTP_503';
  if (isHttp503) {
    return {
      excludeCurrentProvider: true,
      retryAction: 'reroute_explicit_alternative'
    };
  }
  if (args.promptTooLong) {
    return {
      excludeCurrentProvider: true,
      retryAction: 'reroute_explicit_alternative'
    };
  }
  if (args.classification === 'special_400') {
    return {
      excludeCurrentProvider: true,
      retryAction: 'reroute_explicit_alternative'
    };
  }
  if (args.classification === 'unrecoverable') {
    return {
      excludeCurrentProvider: true,
      retryAction: 'reroute_explicit_alternative'
    };
  }
  if (args.classification === 'recoverable') {
    return {
      excludeCurrentProvider: true,
      retryAction: 'reroute_explicit_alternative'
    };
  }
  if (args.isProviderTrafficSaturated || args.isNetworkTransport) {
    return {
      excludeCurrentProvider: true,
      retryAction: 'reroute_explicit_alternative'
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

export function shouldKeepProviderExcludedForNextAttempt(args: {
  hasAlternativeCandidate: boolean;
}): boolean {
  return args.hasAlternativeCandidate;
}

export function shouldDirectReturnUnrecoverableWithoutForcedExclusion(args: {
  classification?: ProviderFailureClassification;
  excludedCurrentProvider: boolean;
  retryable?: boolean;
}): boolean {
  return args.classification === 'unrecoverable' && !args.excludedCurrentProvider && args.retryable !== true;
}

export function shouldCancelUnrecoverableRerouteWithoutAlternative(args: {
  classification?: ProviderFailureClassification;
  switchAction: ProviderFailureRetryAction;
  hasAlternativeCandidate: boolean;
}): boolean {
  return args.classification === 'unrecoverable'
    && args.switchAction === 'reroute_explicit_alternative'
    && !args.hasAlternativeCandidate;
}

export function shouldSuppressForcedProviderExclusion(args: {
  classification?: ProviderFailureClassification;
  stage?: string;
}): boolean {
  return args.classification === 'special_400'
    || args.stage === 'host.response_contract'
    || args.stage === 'provider.followup';
}

export function isProviderFailureHealthNeutral(args: {
  stage?: string;
  error?: unknown;
  errorCode?: string;
  upstreamCode?: string;
  statusCode?: number;
  classification?: ProviderFailureClassification;
}): boolean {
  if (args.stage === 'provider.followup') {
    return true;
  }
  const statusCode =
    typeof args.statusCode === 'number'
      ? args.statusCode
      : extractProviderFailureStatusCode(args.error);
  const errorCode = normalizeProviderFailureCodeKey(args.errorCode);
  const upstreamCode = normalizeProviderFailureCodeKey(args.upstreamCode);
  if (statusCode === 503 || errorCode === 'HTTP_503' || upstreamCode === 'HTTP_503') {
    return false;
  }
  if (args.classification === 'special_400') {
    return true;
  }
  if (errorCode === 'CLIENT_DISCONNECTED' || upstreamCode === 'CLIENT_DISCONNECTED') {
    return true;
  }
  if (isProviderFailureClientDisconnect(args.error)) {
    return true;
  }
  if (args.classification === 'recoverable') {
    // Unified policy: all recoverable failures are health-affecting so they can
    // enter the same VR cooldown/quarantine pipeline (3 strikes + ladder cooldown).
    return false;
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
