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
  return undefined;
}

/**
 * Resolve boolean from environment variable
 */
export function resolveBoolFromEnv(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
}