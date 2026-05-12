import { getSessionClientRegistry } from '../session-client-registry.js';
import { logExecutorRuntimeNonBlockingWarning } from './servertool-runtime-log.js';
import { extractStatusCodeFromError } from './utils.js';

export {
  extractStatusCodeFromError
};

const RATE_LIMIT_ERROR_CODE_HINTS = [
  '429',
  '1302',
  'rate_limit',
  'rate-limit',
  'too_many_requests',
  'too-many-requests',
  'too many requests'
];

const RATE_LIMIT_MESSAGE_HINTS = [
  'rate limit',
  'too many requests',
  'request limit',
  'rate limited',
  'quota exceeded',
  'slow down',
  '访问量过大',
  '速率限制',
  '请求频率',
  '请求过于频繁',
  '频率限制'
];


function logRequestRetryNonBlockingError(stage: string, error: unknown, details?: Record<string, unknown>): void {
  logExecutorRuntimeNonBlockingWarning({
    namespace: 'request-retry',
    stage,
    error,
    details,
    throttleKey: details?.conversationSessionId && details?.tmuxSessionId
      ? `${stage}:${String(details.conversationSessionId)}:${String(details.tmuxSessionId)}`
      : undefined
  });
}

function coerceErrorCode(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function isRateLimitLikeError(message: string, ...codes: Array<string | undefined>): boolean {
  const loweredMessage = String(message || '').toLowerCase();
  const normalizedCodes = codes
    .map((code) => coerceErrorCode(code))
    .filter((code) => code.length > 0);
  if (normalizedCodes.some((code) => RATE_LIMIT_ERROR_CODE_HINTS.some((hint) => code.includes(hint)))) {
    return true;
  }
  return RATE_LIMIT_MESSAGE_HINTS.some((hint) => loweredMessage.includes(hint));
}

export function isSseDecodeRateLimitError(error: unknown, status: number | undefined): boolean {
  if (status !== 429 || !error || typeof error !== 'object') {
    return false;
  }
  const record = error as Record<string, unknown>;
  const message = typeof record.message === 'string' ? record.message : '';
  const code = typeof record.code === 'string' ? record.code : '';
  const upstreamCode = typeof record.upstreamCode === 'string' ? record.upstreamCode : '';
  const name = typeof record.name === 'string' ? record.name.toLowerCase() : '';
  const sseLike =
    code === 'SSE_DECODE_ERROR' ||
    name === 'providerprotocolerror' ||
    message.toLowerCase().includes('sse');
  return sseLike && isRateLimitLikeError(message, code, upstreamCode);
}

export function isSseDecodeRetryableNetworkError(error: unknown, status: number | undefined): boolean {
  if (status !== 502 || !error || typeof error !== 'object') {
    return false;
  }
  const record = error as Record<string, unknown>;
  const message = typeof record.message === 'string' ? record.message.toLowerCase() : '';
  const code = typeof record.code === 'string' ? record.code : '';
  const upstreamCode = typeof record.upstreamCode === 'string' ? record.upstreamCode.toLowerCase() : '';
  const name = typeof record.name === 'string' ? record.name.toLowerCase() : '';
  const sseLike =
    code === 'HTTP_502' ||
    code === 'SSE_DECODE_ERROR' ||
    name === 'providerprotocolerror' ||
    message.includes('upstream sse error event') ||
    message.includes('anthropic sse error event');
  if (!sseLike) {
    return false;
  }
  return (
    upstreamCode.includes('internal_network_failure') ||
    message.includes('internal network failure') ||
    message.includes('network failure') ||
    message.includes('network error') ||
    message.includes('service unavailable') ||
    message.includes('temporarily unavailable') ||
    message.includes('connection reset') ||
    message.includes('timeout') ||
    upstreamCode.includes('upstream_stream_no_content_timeout') ||
    upstreamCode.includes('upstream_stream_content_idle_timeout')
  );
}

function normalizeSessionToken(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function resolveSessionConversationSessionId(metadata: Record<string, unknown>): string | undefined {
  const tmuxSessionId = normalizeSessionToken(metadata.clientTmuxSessionId)
    ?? normalizeSessionToken(metadata.client_tmux_session_id)
    ?? normalizeSessionToken(metadata.tmuxSessionId)
    ?? normalizeSessionToken(metadata.tmux_session_id);
  if (tmuxSessionId) {
    return `tmux:${tmuxSessionId}`;
  }
  return undefined;
}

function inferSessionClientTypeFromMetadata(metadata: Record<string, unknown>): string | undefined {
  const direct = normalizeSessionToken(metadata.sessionClientType) ?? normalizeSessionToken(metadata.clientType);
  if (direct) {
    return direct;
  }

  const userAgent = normalizeSessionToken(metadata.userAgent)?.toLowerCase() ?? '';
  if (userAgent.includes('codex')) {
    return 'codex';
  }
  if (userAgent.includes('claude')) {
    return 'claude';
  }
  return undefined;
}

export function bindSessionConversationSession(metadata: Record<string, unknown>): void {
  const conversationSessionId = resolveSessionConversationSessionId(metadata);
  if (!conversationSessionId) {
    return;
  }

  const tmuxSessionId = normalizeSessionToken(metadata.clientTmuxSessionId)
    ?? normalizeSessionToken(metadata.client_tmux_session_id)
    ?? normalizeSessionToken(metadata.tmuxSessionId);
  const clientType = inferSessionClientTypeFromMetadata(metadata);
  const workdir = normalizeSessionToken(metadata.clientWorkdir)
    ?? normalizeSessionToken(metadata.client_workdir)
    ?? normalizeSessionToken(metadata.workdir)
    ?? normalizeSessionToken(metadata.cwd)
    ?? normalizeSessionToken(metadata.workingDirectory);

  try {
    const bindInput: {
      conversationSessionId: string;
      tmuxSessionId?: string;
      clientType?: string;
      workdir?: string;
    } = {
      conversationSessionId,
      ...(tmuxSessionId ? { tmuxSessionId } : {}),
      ...(clientType ? { clientType } : {}),
      ...(workdir ? { workdir } : {})
    };
    getSessionClientRegistry().bindConversationSession(bindInput);
  } catch (error) {
    logRequestRetryNonBlockingError('bindSessionConversationSession', error, {
      conversationSessionId,
      tmuxSessionId,
      clientType,
      hasWorkdir: Boolean(workdir)
    });
  }
}
