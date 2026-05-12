/**
 * Utility functions for request-executor
 *
 * Common helper functions used across executor submodules.
 */

/**
 * Get first non-empty string from candidates array
 */
export function firstNonEmptyString(candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') {
      continue;
    }
    const trimmed = candidate.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

/**
 * Get first finite number from candidates array
 */
export function firstFiniteNumber(candidates: unknown[]): number | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Extract HTTP status code from error object
 */
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

/**
 * Resolve boolean from environment variable
 */
export function resolveBoolFromEnv(value: string | undefined, defaultValue: boolean): boolean {
  if (!value) {
    return defaultValue;
  }
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return defaultValue;
}
