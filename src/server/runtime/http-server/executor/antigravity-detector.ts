/**
 * Antigravity Provider Detector
 *
 * Detects Antigravity-specific errors and provider keys.
 */

import { extractStatusCodeFromError } from '../executor/utils.js';

/**
 * Check if provider key belongs to Antigravity family
 */
export function isAntigravityProviderKey(providerKey: string | undefined): boolean {
  return typeof providerKey === 'string' && providerKey.startsWith('antigravity.');
}

/**
 * Detect Google account verification required error (403 with specific messages)
 */
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
    // Antigravity-Manager alignment: 403 validation gating keywords.
    lowered.includes('validation_required') ||
    lowered.includes('validation required') ||
    lowered.includes('validation_url') ||
    lowered.includes('validation url') ||
    lowered.includes('accounts.google.com/signin/continue') ||
    lowered.includes('support.google.com/accounts?p=al_alert')
  );
}

/**
 * Detect Antigravity reauth required 403 (OAuth token expired/invalid)
 */
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

/**
 * Extract retry error signature for Antigravity tracking
 */
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

/**
 * Determine if should rotate Antigravity alias on retry
 * Safety: do not rotate between Antigravity aliases within a single request
 */
export function shouldRotateAntigravityAliasOnRetry(): boolean {
  // Multi-account switching (especially during 4xx/429 states)
  // can cascade into cross-account reauth (403 verify) events.
  return false;
}

/**
 * Inject Antigravity retry signal into metadata
 */
export function injectAntigravityRetrySignal(
  metadata: Record<string, unknown>,
  signal: { signature: string; consecutive: number; avoidAllOnRetry?: boolean } | null
): void {
  if (!signal || !signal.signature || signal.consecutive <= 0) {
    return;
  }
  const carrier = metadata as { __rt?: unknown };
  const existing = carrier.__rt && typeof carrier.__rt === 'object' && !Array.isArray(carrier.__rt)
    ? carrier.__rt
    : {};
  carrier.__rt = {
    ...(existing as Record<string, unknown>),
    antigravityRetryErrorSignature: signal.signature,
    antigravityRetryErrorConsecutive: signal.consecutive,
    ...(signal.avoidAllOnRetry === true ? { antigravityAvoidAllOnRetry: true } : {})
  };
}