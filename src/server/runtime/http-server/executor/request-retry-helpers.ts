import { getClockClientRegistry } from '../clock-client-registry.js';

const DEFAULT_ANTIGRAVITY_MAX_PROVIDER_ATTEMPTS = 20;

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
  '速率限制',
  '请求频率',
  '请求过于频繁',
  '频率限制'
];

export type AntigravityRetrySignal = {
  signature: string;
  consecutive: number;
  avoidAllOnRetry?: boolean;
};

export function resolveAntigravityMaxProviderAttempts(): number {
  const raw = String(
    process.env.ROUTECODEX_ANTIGRAVITY_MAX_PROVIDER_ATTEMPTS || process.env.RCC_ANTIGRAVITY_MAX_PROVIDER_ATTEMPTS || ''
  )
    .trim()
    .toLowerCase();
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  const candidate = Number.isFinite(parsed) ? parsed : DEFAULT_ANTIGRAVITY_MAX_PROVIDER_ATTEMPTS;
  return Math.max(1, Math.min(60, candidate));
}

export function isAntigravityProviderKey(providerKey: string | undefined): boolean {
  return typeof providerKey === 'string' && providerKey.startsWith('antigravity.');
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

export function isGoogleAccountVerificationRequiredError(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false;
  }
  const messageRaw = (err as { message?: unknown }).message;
  const message = typeof messageRaw === 'string' ? messageRaw : '';
  if (!message) {
    return false;
  }
  const lowered = message.toLowerCase();
  return (
    lowered.includes('verify your account') ||
    lowered.includes('validation_required') ||
    lowered.includes('validation required') ||
    lowered.includes('validation_url') ||
    lowered.includes('validation url') ||
    lowered.includes('accounts.google.com/signin/continue') ||
    lowered.includes('support.google.com/accounts?p=al_alert')
  );
}

export function extractStatusCodeFromError(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const direct = (err as any).statusCode;
  if (typeof direct === 'number') return direct;
  const nested = (err as any).status;
  if (typeof nested === 'number') return nested;
  const details = (err as any).details;
  if (details && typeof details === 'object') {
    const detailStatusCode = (details as any).statusCode;
    if (typeof detailStatusCode === 'number') return detailStatusCode;
    const detailStatus = (details as any).status;
    if (typeof detailStatus === 'number') return detailStatus;
  }
  const response = (err as any).response;
  if (response && typeof response === 'object') {
    const responseStatus = (response as any).status;
    if (typeof responseStatus === 'number') return responseStatus;
  }
  return undefined;
}

export function isAntigravityReauthRequired403(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false;
  }
  const status = extractStatusCodeFromError(err);
  if (status !== 403) {
    return false;
  }
  if (isGoogleAccountVerificationRequiredError(err)) {
    return false;
  }
  const messageRaw = (err as { message?: unknown }).message;
  const message = typeof messageRaw === 'string' ? messageRaw : '';
  if (!message) {
    return false;
  }
  const lowered = message.toLowerCase();
  return (
    lowered.includes('please authenticate with google oauth first') ||
    lowered.includes('authenticate with google oauth') ||
    lowered.includes('missing required authentication credential') ||
    lowered.includes('request is missing required authentication') ||
    lowered.includes('unauthenticated') ||
    lowered.includes('invalid token') ||
    lowered.includes('invalid_grant') ||
    lowered.includes('unauthorized') ||
    lowered.includes('token expired') ||
    lowered.includes('expired token')
  );
}

export function shouldRotateAntigravityAliasOnRetry(_error: unknown): boolean {
  return false;
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

export function extractRetryErrorSignature(err: unknown): string {
  if (!err || typeof err !== 'object') {
    return 'unknown';
  }
  const status = extractStatusCodeFromError(err);
  if (status === 403 && isGoogleAccountVerificationRequiredError(err)) {
    return '403:GOOGLE_VERIFY';
  }
  if (status === 403 && isAntigravityReauthRequired403(err)) {
    return '403:OAUTH_REAUTH';
  }
  const codeRaw = (err as { code?: unknown }).code;
  const upstreamCodeRaw = (err as { upstreamCode?: unknown }).upstreamCode;
  const upstreamCode =
    typeof upstreamCodeRaw === 'string' && upstreamCodeRaw.trim() ? upstreamCodeRaw.trim() : undefined;
  const code = typeof codeRaw === 'string' && codeRaw.trim() ? codeRaw.trim() : undefined;
  const parts = [
    typeof status === 'number' && Number.isFinite(status) ? String(status) : '',
    upstreamCode || '',
    code || ''
  ].filter((p) => p.length > 0);
  return parts.length ? parts.join(':') : 'unknown';
}

export function injectAntigravityRetrySignal(
  metadata: Record<string, unknown>,
  signal: AntigravityRetrySignal | null
): void {
  if (!signal || !signal.signature || signal.consecutive <= 0) {
    return;
  }
  const carrier = metadata as { __rt?: unknown };
  const existing = carrier.__rt && typeof carrier.__rt === 'object' && !Array.isArray(carrier.__rt) ? carrier.__rt : {};
  carrier.__rt = {
    ...(existing as Record<string, unknown>),
    antigravityRetryErrorSignature: signal.signature,
    antigravityRetryErrorConsecutive: signal.consecutive,
    ...(signal.avoidAllOnRetry === true ? { antigravityAvoidAllOnRetry: true } : {})
  };
}

function normalizeSessionToken(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function resolveClockConversationSessionId(metadata: Record<string, unknown>): string | undefined {
  const daemonId = normalizeSessionToken(metadata.clockDaemonId)
    ?? normalizeSessionToken(metadata.clockClientDaemonId);
  if (daemonId) {
    return `clockd.${daemonId}`;
  }
  return normalizeSessionToken(metadata.sessionId);
}

function inferClockClientTypeFromMetadata(metadata: Record<string, unknown>): string | undefined {
  const direct = normalizeSessionToken(metadata.clockClientType) ?? normalizeSessionToken(metadata.clientType);
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

export function bindClockConversationSession(metadata: Record<string, unknown>): void {
  const conversationSessionId = resolveClockConversationSessionId(metadata);
  if (!conversationSessionId) {
    return;
  }

  const daemonId = normalizeSessionToken(metadata.clockDaemonId)
    ?? normalizeSessionToken(metadata.clockClientDaemonId);
  const tmuxSessionId = normalizeSessionToken(metadata.tmuxSessionId);
  const clientType = inferClockClientTypeFromMetadata(metadata);
  const workdir = normalizeSessionToken(metadata.workdir)
    ?? normalizeSessionToken(metadata.cwd)
    ?? normalizeSessionToken(metadata.workingDirectory);

  try {
    getClockClientRegistry().bindConversationSession({
      conversationSessionId,
      ...(tmuxSessionId ? { tmuxSessionId } : {}),
      ...(daemonId ? { daemonId } : {}),
      ...(clientType ? { clientType } : {}),
      ...(workdir ? { workdir } : {})
    });
  } catch {
    // best-effort only
  }
}
