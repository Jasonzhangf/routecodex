import type { ProviderErrorEvent } from '../../../modules/llmswitch/bridge.js';

export function extractProviderKey(event: ProviderErrorEvent): string | null {
  const runtime = event.runtime as { providerKey?: unknown; target?: unknown } | undefined;
  const direct =
    runtime && typeof runtime.providerKey === 'string' && runtime.providerKey.trim()
      ? runtime.providerKey.trim()
      : null;
  if (direct) {
    return direct;
  }
  const target = runtime && runtime.target;
  if (target && typeof target === 'object') {
    const targetKey = (target as { providerKey?: unknown }).providerKey;
    if (typeof targetKey === 'string' && targetKey.trim()) {
      return targetKey.trim();
    }
  }
  return null;
}

export function extractAntigravityAlias(providerKey: string): string | null {
  const parts = String(providerKey || '').trim().split('.').filter(Boolean);
  if (parts.length < 3) {
    return null;
  }
  if (parts[0].toLowerCase() !== 'antigravity') {
    return null;
  }
  const alias = String(parts[1] || '').trim().toLowerCase();
  return alias ? alias : null;
}

export function listAntigravityProviderKeysByAlias(
  ctx: { quotaStates: Map<string, unknown>; staticConfigs: Map<string, unknown> },
  alias: string
): string[] {
  const prefix = `antigravity.${alias}.`;
  const keys = new Set<string>();
  for (const key of ctx.quotaStates.keys()) {
    if (key.toLowerCase().startsWith(prefix)) {
      keys.add(key);
    }
  }
  for (const key of ctx.staticConfigs.keys()) {
    if (key.toLowerCase().startsWith(prefix)) {
      keys.add(key);
    }
  }
  return Array.from(keys.values());
}

export function parseAntigravityGoogleAccountVerification(event: ProviderErrorEvent): { url: string | null; message: string } | null {
  const status = typeof event.status === 'number' ? event.status : undefined;
  if (status !== 403) {
    return null;
  }
  const raw = typeof event.message === 'string' ? event.message : '';
  if (!raw) {
    return null;
  }
  const normalized = normalizeOAuthErrorMessageForUrl(raw);
  const lowered = normalized.toLowerCase();
  const isMatch =
    lowered.includes('verify your account') ||
    // Antigravity-Manager alignment: 403 validation gating keywords.
    lowered.includes('validation_required') ||
    lowered.includes('validation required') ||
    lowered.includes('validation_url') ||
    lowered.includes('validation url') ||
    lowered.includes('accounts.google.com/signin/continue') ||
    lowered.includes('support.google.com/accounts?p=al_alert');
  if (!isMatch) {
    return null;
  }
  const url =
    extractFirstUrl(normalized, /https?:\/\/accounts\.google\.com\/signin\/continue[^\s"'<>)]*/i) ||
    extractFirstUrl(normalized, /https?:\/\/accounts\.google\.com\/[^\s"'<>)]*/i) ||
    extractFirstUrl(normalized, /https?:\/\/support\.google\.com\/accounts\?p=al_alert[^\s"'<>)]*/i) ||
    null;
  return {
    url,
    message: 'Google account verification required (open the link and complete the flow, then re-authorize OAuth).'
  };
}

export function isAntigravityReauthRequired403(event: ProviderErrorEvent): boolean {
  try {
    const status = typeof event.status === 'number' ? event.status : undefined;
    if (status !== 403) {
      return false;
    }
    // Exclude Google verification gating: handled separately.
    if (parseAntigravityGoogleAccountVerification(event)) {
      return false;
    }
    const raw = typeof event.message === 'string' ? event.message : '';
    if (!raw) {
      return false;
    }
    const lowered = raw.toLowerCase();
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
  } catch {
    return false;
  }
}

function normalizeOAuthErrorMessageForUrl(input: string): string {
  return String(input || '')
    .replace(/\\\//g, '/')
    .replace(/\\u0026/gi, '&')
    .replace(/\\u003d/gi, '=')
    .replace(/\\x26/gi, '&')
    .replace(/\\x3d/gi, '=')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\n');
}

function extractFirstUrl(input: string, pattern: RegExp): string | null {
  try {
    const match = pattern.exec(input);
    if (!match) return null;
    const raw = String(match[0] || '').trim();
    const url = raw.replace(/[\\"']+$/g, '').replace(/[),.]+$/g, '');
    return url ? url : null;
  } catch {
    return null;
  }
}

export function isFatalForQuota(event: ProviderErrorEvent): boolean {
  const status = typeof event.status === 'number' ? event.status : undefined;
  const code = typeof event.code === 'string' ? event.code.toUpperCase() : '';
  const stage = typeof event.stage === 'string' ? event.stage.toLowerCase() : '';

  if (isIflowAkBlocked434(event)) {
    return true;
  }

  if (status === 401 || status === 402 || status === 403) {
    return true;
  }
  if (code.includes('AUTH') || code.includes('UNAUTHORIZED')) {
    return true;
  }
  if (code.includes('CONFIG')) {
    return true;
  }
  if (stage.includes('compat')) {
    return true;
  }
  if (event.recoverable === false && status !== undefined && status >= 500) {
    return true;
  }
  return false;
}

export function isIflowAkBlocked434(event: ProviderErrorEvent): boolean {
  const status = typeof event.status === 'number' ? event.status : undefined;
  if (status === 434) {
    return true;
  }

  const message = typeof event.message === 'string' ? event.message.toLowerCase() : '';
  if (message.includes('access to the current ak has been blocked due to unauthorized requests')) {
    return true;
  }
  if (message.includes('iflow business error (434)')) {
    return true;
  }

  const details = event.details && typeof event.details === 'object'
    ? (event.details as Record<string, unknown>)
    : null;
  if (!details) {
    return false;
  }

  const upstreamCode = typeof details.upstreamCode === 'string'
    ? details.upstreamCode.trim().toLowerCase()
    : '';
  if (upstreamCode === '434') {
    return true;
  }

  const statusCode = typeof details.statusCode === 'number' ? details.statusCode : undefined;
  if (statusCode === 434) {
    return true;
  }

  const upstreamMessage = typeof details.upstreamMessage === 'string'
    ? details.upstreamMessage.toLowerCase()
    : '';
  return upstreamMessage.includes('access to the current ak has been blocked due to unauthorized requests');
}
