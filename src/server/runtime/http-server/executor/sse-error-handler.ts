/**
 * SSE Error Handler for request-executor
 *
 * Extracts and normalizes SSE wrapper errors from responses.
 */

import { isRetryableSseWrapperError } from './retry-engine.js';
import { firstNonEmptyString, firstFiniteNumber } from '../executor/utils.js';

export type SseWrapperErrorInfo = {
  message: string;
  errorCode?: string;
  statusCode?: number;
  retryable: boolean;
};

/**
 * Extract SSE wrapper error from payload with depth-limited recursion
 */
export function extractSseWrapperError(
  payload: Record<string, unknown> | undefined
): SseWrapperErrorInfo | undefined {
  return findSseWrapperError(payload, 2);
}

/**
 * Recursively find SSE wrapper error in nested structures
 */
function findSseWrapperError(
  record: Record<string, unknown> | undefined,
  depth: number
): SseWrapperErrorInfo | undefined {
  if (!record || typeof record !== 'object' || depth < 0) {
    return undefined;
  }

  if (record.mode === 'sse') {
    const normalized = normalizeSseWrapperErrorValue(record.error, depth);
    if (normalized) {
      return normalized;
    }
  }

  const nestedKeys = ['body', 'data', 'payload', 'response'];
  for (const key of nestedKeys) {
    const nested = record[key];
    if (!nested || typeof nested !== 'object' || Array.isArray(nested)) {
      continue;
    }
    const found = findSseWrapperError(nested as Record<string, unknown>, depth - 1);
    if (found) {
      return found;
    }
  }

  return undefined;
}

/**
 * Normalize error value from SSE wrapper into structured info
 */
function normalizeSseWrapperErrorValue(
  value: unknown,
  depth: number
): SseWrapperErrorInfo | undefined {
  if (value === undefined || value === null || depth < 0) {
    return undefined;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }

    if (depth > 0 && (trimmed.startsWith('{') || trimmed.startsWith('['))) {
      try {
        const parsed = JSON.parse(trimmed);
        const parsedInfo = normalizeSseWrapperErrorValue(parsed, depth - 1);
        if (parsedInfo) {
          return parsedInfo;
        }
      } catch {
        // fallback to raw string
      }
    }

    const bracketCodeMatch = trimmed.match(/\[([^\]]+)\]/);
    const bracketCode = bracketCodeMatch && bracketCodeMatch[1] ? bracketCodeMatch[1].trim() : '';
    const parsedStatus =
      /^\d+$/.test(bracketCode) && Number(bracketCode) >= 100 && Number(bracketCode) <= 599
        ? Number(bracketCode)
        : undefined;

    return {
      message: trimmed,
      ...(bracketCode ? { errorCode: bracketCode } : {}),
      ...(parsedStatus !== undefined ? { statusCode: parsedStatus } : {}),
      retryable: isRetryableSseWrapperError(trimmed, bracketCode || undefined, parsedStatus)
    };
  }

  if (typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const directMessage = firstNonEmptyString([
    record.message,
    record.error_message,
    record.errorMessage
  ]);
  const directCode = firstNonEmptyString([
    record.code,
    record.error_code,
    record.errorCode,
    record.type
  ]);
  const directStatus = firstFiniteNumber([
    record.status,
    record.statusCode,
    record.status_code,
    record.http_status
  ]);

  if (depth > 0) {
    for (const key of ['error', 'data', 'payload', 'details', 'body', 'response']) {
      const nestedInfo = normalizeSseWrapperErrorValue(record[key], depth - 1);
      if (nestedInfo) {
        const mergedCode = nestedInfo.errorCode ?? directCode;
        const mergedStatus = nestedInfo.statusCode ?? directStatus;
        const retryable = nestedInfo.retryable ||
          isRetryableSseWrapperError(nestedInfo.message, mergedCode, mergedStatus);
        return {
          message: nestedInfo.message,
          ...(mergedCode ? { errorCode: mergedCode } : {}),
          ...(mergedStatus !== undefined ? { statusCode: mergedStatus } : {}),
          retryable
        };
      }
    }
  }

  if (directMessage) {
    return {
      message: directMessage,
      ...(directCode ? { errorCode: directCode } : {}),
      ...(directStatus !== undefined ? { statusCode: directStatus } : {}),
      retryable: isRetryableSseWrapperError(directMessage, directCode, directStatus)
    };
  }

  try {
    const serialized = JSON.stringify(record);
    if (serialized && serialized !== '{}') {
      return {
        message: serialized,
        ...(directCode ? { errorCode: directCode } : {}),
        ...(directStatus !== undefined ? { statusCode: directStatus } : {}),
        retryable: isRetryableSseWrapperError(serialized, directCode, directStatus)
      };
    }
  } catch {
    // ignore stringify failures
  }

  return undefined;
}
