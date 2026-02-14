/**
 * Error Extraction Utilities
 *
 * Extracts status codes and verification URLs from OAuth errors.
 */

/**
 * Extract HTTP status code from error object
 */
export function extractStatusCode(upstreamError: unknown): number | undefined {
  if (!upstreamError || typeof upstreamError !== 'object') {
    return undefined;
  }
  const anyErr = upstreamError as any;
  const direct = anyErr.statusCode;
  if (typeof direct === 'number' && Number.isFinite(direct)) {
    return direct;
  }
  const status = anyErr.status;
  if (typeof status === 'number' && Number.isFinite(status)) {
    return status;
  }
  const response = anyErr.response;
  if (response && typeof response === 'object') {
    const respStatus = (response as any).status;
    if (typeof respStatus === 'number' && Number.isFinite(respStatus)) {
      return respStatus;
    }
    const respStatusCode = (response as any).statusCode;
    if (typeof respStatusCode === 'number' && Number.isFinite(respStatusCode)) {
      return respStatusCode;
    }
  }
  return undefined;
}

/**
 * Check if message indicates Google account verification required
 */
export function isGoogleAccountVerificationRequiredMessage(lower: string): boolean {
  if (!lower) {
    return false;
  }
  return (
    lower.includes('verify your account') ||
    lower.includes('validation_required') ||
    lower.includes('validation required') ||
    lower.includes('validation_url') ||
    lower.includes('validation url') ||
    lower.includes('accounts.google.com/signin/continue') ||
    lower.includes('support.google.com/accounts?p=al_alert')
  );
}

/**
 * Extract Google account verification URL from error message
 */
export function extractGoogleAccountVerificationUrl(message: string): string | null {
  const msg = typeof message === 'string' ? message : '';
  if (!msg) {
    return null;
  }
  const normalized = msg
    .replace(/\\\//g, '/')
    .replace(/\\u0026/gi, '&')
    .replace(/\\u003d/gi, '=')
    .replace(/\\x26/gi, '&')
    .replace(/\\x3d/gi, '=');
  const patterns: RegExp[] = [
    /https:\/\/accounts\.google\.com\/signin\/continue[^\s"'\\<>)]*/i,
    /https:\/\/accounts\.google\.com\/[^\s"'\\<>)]*/i,
    /https:\/\/support\.google\.com\/accounts\?p=al_alert[^\s"'\\<>)]*/i
  ];
  for (const re of patterns) {
    const m = normalized.match(re);
    if (m && m[0]) {
      const url = String(m[0]).trim().replace(/[\\"']+$/g, '').replace(/[),.]+$/g, '');
      if (url) {
        return url;
      }
    }
  }
  return null;
}