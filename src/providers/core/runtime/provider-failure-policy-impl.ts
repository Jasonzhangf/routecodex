/**
 * feature_id: error.provider_failure_policy
 */
/**
 * Provider failure policy implementation.
 * Orchestrates classification / action plan blocks as the app-layer truth.
 */

import type {
  ProviderFailureClassification,
  ProviderFailureRetryAction,
  ProviderFailureActionPlan,
  ProviderFailureOutcome,
} from './provider-failure-policy.js';
import {
  PROVIDER_NETWORK_CODES,
} from './provider-error-catalog.js';
import { classifyErrorErr02HostCapturedNative } from '../../../modules/llmswitch/bridge/error-execution-decision-host.js';

const NETWORK_ERROR_CODE_SET: ReadonlySet<string> = PROVIDER_NETWORK_CODES;

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
  const rawMessage =
    typeof args.reason === 'string' && args.reason.trim()
      ? args.reason
      : (args.error as { message?: unknown } | undefined)?.message;
  const details =
    args.error && typeof args.error === 'object' && !Array.isArray(args.error)
      ? (args.error as { details?: unknown }).details
      : undefined;
  const detailRecord =
    details && typeof details === 'object' && !Array.isArray(details)
      ? details as Record<string, unknown>
      : undefined;
  const detailReason = typeof detailRecord?.reason === 'string' ? detailRecord.reason : '';
  const detailUpstreamCode = typeof detailRecord?.upstreamCode === 'string' ? detailRecord.upstreamCode : '';
  const message = [
    typeof rawMessage === 'string' ? rawMessage : '',
    detailReason,
    detailUpstreamCode
  ].join(' ').toLowerCase();
  const isPayloadSizeLimit =
    message.includes('request entity too large')
    || message.includes('payload too large')
    || message.includes('body too large');
  if (isPayloadSizeLimit) {
    return true;
  }
  if (typeof args.statusCode === 'number' && args.statusCode !== 400) {
    return false;
  }
  return (
    message.includes('prompt is too long')
    || message.includes('maximum context')
    || message.includes('max context')
    || message.includes('context_length')
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

function isLocalResponseContractValidationError(reason: string): boolean {
  return reason.includes('[mimoweb] upstream assistant response was empty')
    || reason.includes('[mimoweb] upstream emitted tool markers but no tool calls could be harvested')
    || reason.includes('[mimoweb] upstream repeated prior tool call after tool_result')
    || reason.includes('[mimoweb] serialized query exceeds empty-safe limit');
}

function isLocalRequestContractValidationError(args: {
  statusCode?: number;
  nestedParam?: string;
  nestedType?: string;
  nestedCode?: string;
  errorCode?: string;
  upstreamCode?: string;
  reason?: string;
}): boolean {
  const nestedParam = args.nestedParam ?? '';
  const nestedType = String(args.nestedType ?? '');
  const nestedCode = String(args.nestedCode ?? '');
  const errorCode = String(args.errorCode ?? '');
  const upstreamCode = String(args.upstreamCode ?? '');
  const reason = String(args.reason ?? '').toLowerCase();
  return (
    nestedParam.startsWith('tools.')
    || nestedParam.startsWith('messages.')
    || nestedParam.startsWith('input.')
    || nestedType === 'INVALID_REQUEST_ERROR'
    || nestedType.startsWith('INVALID_')
    || nestedCode.startsWith('INVALID_')
    || errorCode === 'INVALID_REQUEST_ERROR'
    || upstreamCode === 'INVALID_REQUEST_ERROR'
    || reason.includes('invalid request payload')
    || reason.includes('"message":"bad request"')
    || reason.includes('signature-invalid')
  );
}

export function resolveProviderFailureClassification(args: {
  error: unknown;
  stage?: string;
  statusCode?: number;
  errorCode?: string;
  upstreamCode?: string;
  reason?: string;
}): ProviderFailureClassification | undefined {
  const error = args.error && typeof args.error === 'object' && !Array.isArray(args.error)
    ? args.error as Record<string, unknown>
    : {};
  const details = error.details && typeof error.details === 'object' && !Array.isArray(error.details)
    ? error.details as Record<string, unknown>
    : {};
  const response = error.response && typeof error.response === 'object' && !Array.isArray(error.response)
    ? error.response as Record<string, unknown>
    : {};
  const data = response.data && typeof response.data === 'object' && !Array.isArray(response.data)
    ? response.data as Record<string, unknown>
    : {};
  const nestedError = data.error && typeof data.error === 'object' && !Array.isArray(data.error)
    ? data.error as Record<string, unknown>
    : {};
  const nativeDecision = classifyErrorErr02HostCapturedNative({
    stage: args.stage,
    statusCode: typeof args.statusCode === 'number'
      ? args.statusCode
      : extractProviderFailureStatusCode(args.error),
    errorCode: normalizeProviderFailureCodeKey(args.errorCode ?? error.code),
    upstreamCode: normalizeProviderFailureCodeKey(args.upstreamCode ?? error.upstreamCode),
    reason: typeof args.reason === 'string'
      ? args.reason
      : typeof error.message === 'string'
        ? error.message
        : undefined,
    errorMessage: typeof error.message === 'string' ? error.message : undefined,
    errorName: typeof error.name === 'string' ? error.name : undefined,
    detailReason: typeof details.reason === 'string' ? details.reason : undefined,
    detailUpstreamCode: typeof details.upstreamCode === 'string' ? details.upstreamCode : undefined,
    detailUpstreamMessage: typeof details.upstreamMessage === 'string' ? details.upstreamMessage : undefined,
    responseErrorMessage: typeof nestedError.message === 'string' ? nestedError.message : undefined,
    responseErrorCode: typeof nestedError.code === 'string' ? nestedError.code : undefined,
    responseErrorType: typeof nestedError.type === 'string' ? nestedError.type : undefined,
    responseErrorParam: typeof nestedError.param === 'string' ? nestedError.param : undefined,
    providerStatusCode: typeof details.providerStatusCode === 'number'
      ? details.providerStatusCode
      : undefined,
  });
  return nativeDecision.classification;
}
export function resolveProviderFailureOutcome(args: {
  error: unknown;
  stage?: string;
  statusCode?: number;
  errorCode?: string;
  upstreamCode?: string;
  reason?: string;
  classification?: ProviderFailureClassification;
}): ProviderFailureOutcome {
  const classification =
    args.classification
    ?? resolveProviderFailureClassification({
      error: args.error,
      stage: args.stage,
      statusCode: args.statusCode,
      errorCode: args.errorCode,
      upstreamCode: args.upstreamCode,
      reason: args.reason
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
      classification,
      reason: args.reason
    })
  };
}

export function resolveProviderFailureActionPlan(args: {
  error: unknown;
  stage?: string;
  statusCode?: number;
  errorCode?: string;
  upstreamCode?: string;
  reason?: string;
  classification?: ProviderFailureClassification;
  attempt?: number;
  maxAttempts?: number;
  promptTooLong?: boolean;
  retryAction?: ProviderFailureRetryAction;
}): ProviderFailureActionPlan {
  const resolvedClassification =
    args.classification
    ?? resolveProviderFailureClassification({
      error: args.error,
      stage: args.stage,
      statusCode: args.statusCode,
      errorCode: args.errorCode,
      upstreamCode: args.upstreamCode,
      reason: args.reason
    });
  const classification =
    args.promptTooLong === true
    && resolvedClassification === undefined
      ? 'recoverable'
      : resolvedClassification;
  const affectsHealth = !isProviderFailureHealthNeutral({
    stage: args.stage,
    error: args.error,
    errorCode: args.errorCode,
    upstreamCode: args.upstreamCode,
    statusCode: args.statusCode,
    classification,
    reason: args.reason
  });
  if (classification !== 'recoverable') {
    return {
      classification,
      affectsHealth,
      shouldRetry: false,
      action: 'direct_return',
      decisionLabel: 'direct_return'
    };
  }

  const action = args.retryAction ?? 'reroute_explicit_alternative';
  return {
    classification,
    affectsHealth,
    shouldRetry: true,
    action,
    decisionLabel: 'exclude_and_reroute'
  };
}

export function isProviderFailureHealthNeutral(args: {
  stage?: string;
  error?: unknown;
  errorCode?: string;
  upstreamCode?: string;
  statusCode?: number;
  classification?: ProviderFailureClassification;
  reason?: string;
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
  const reason = typeof args.reason === 'string'
    ? args.reason.trim().toLowerCase()
    : '';
  if (isProviderRuntimeRequestContractError(reason)) {
    return true;
  }
  if (isLocalResponseContractValidationError(reason)) {
    return true;
  }
  const nested = (() => {
    if (!args.error || typeof args.error !== 'object') {
      return {} as {
        code?: string;
        type?: string;
        param?: string;
        message?: string;
      };
    }
    const response = (args.error as { response?: unknown }).response;
    if (!response || typeof response !== 'object') {
      return {} as {
        code?: string;
        type?: string;
        param?: string;
        message?: string;
      };
    }
    const data = (response as { data?: unknown }).data;
    if (!data || typeof data !== 'object') {
      return {} as {
        code?: string;
        type?: string;
        param?: string;
        message?: string;
      };
    }
    const nestedError = (data as { error?: unknown }).error;
    if (!nestedError || typeof nestedError !== 'object' || Array.isArray(nestedError)) {
      return {} as {
        code?: string;
        type?: string;
        param?: string;
        message?: string;
      };
    }
    const record = nestedError as Record<string, unknown>;
    return {
      code: typeof record.code === 'string' ? record.code : undefined,
      type: typeof record.type === 'string' ? record.type : undefined,
      param: typeof record.param === 'string' ? record.param : undefined,
      message: typeof record.message === 'string' ? record.message : undefined
    };
  })();
  if (isLocalRequestContractValidationError({
    statusCode,
    nestedParam: typeof nested.param === 'string' ? nested.param.trim().toLowerCase() : '',
    nestedType: normalizeProviderFailureCodeKey(nested.type),
    nestedCode: normalizeProviderFailureCodeKey(nested.code),
    errorCode,
    upstreamCode,
    reason
  })) {
    return true;
  }
  if (errorCode === 'CLIENT_DISCONNECTED' || upstreamCode === 'CLIENT_DISCONNECTED') {
    return true;
  }
  if (isProviderFailureClientDisconnect(args.error)) {
    return true;
  }
  if (isPromptTooLongLike({
    error: args.error,
    statusCode,
    errorCode,
    upstreamCode,
    reason
  })) {
    return true;
  }
  if (errorCode === 'CLIENT_TOOL_ARGS_INVALID') {
    return true;
  }
  if (upstreamCode === 'CLIENT_INJECT_FAILED') {
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
  const parseStatusCandidate = (value: unknown): number | undefined => {
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
  };
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
