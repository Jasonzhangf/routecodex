/**
 * Tool result text extraction.
 * Direct pass-through strategy: preserve the original result as-is.
 */

export function extractToolText(value: unknown): string {
  // Strategy: direct pass-through without processing
  if (typeof value === 'string') {
    return value;
  }

  // Convert non-string values to string representation
  if (value === null || value === undefined) {
    return '';
  }

  try {
    return String(value);
  } catch {
    return '';
  }
}
