/**
 * Shared common utilities — single source of truth for error formatting,
 * type guards, and other cross-cutting helpers used throughout the codebase.
 *
 * Anti-pattern eliminated: formatUnknownError (79 copies), isRecord (~20 copies).
 */

/**
 * Format an unknown error value into a human-readable string.
 *
 * Priority: Error.stack > Error.name: message > JSON.stringify > String().
 * Never throws — returns a fallback string if all serialization fails.
 */
export function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || `${error.name}: ${error.message}`;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * Type guard: check if a value is a non-null, non-array plain object.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
