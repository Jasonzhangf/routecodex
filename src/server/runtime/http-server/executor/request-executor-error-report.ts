/**
 * Error Reporting Helpers
 *
 * Extracted from request-executor.ts.
 * Non-blocking logging and error formatting utilities.
 */

import { readString } from './request-executor-error-shared.js';
import { normalizeKnownProviderError } from '../../../../providers/core/runtime/provider-error-catalog.js';

const NON_BLOCKING_LOG_THROTTLE_MS = 60_000;
const nonBlockingLogState = new Map<string, number>();
const PROVIDER_ERROR_REPORTED_MARKER = Symbol.for('routecodex.provider.errorReported');

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

export function cloneErrorForReporting(error: unknown): unknown {
  if (!error || typeof error !== 'object') {
    return error;
  }
  if (error instanceof Error) {
    const cloned = new Error(error.message);
    cloned.name = error.name;
    if (typeof error.stack === 'string') {
      cloned.stack = error.stack;
    }
    Object.assign(cloned, error);
    return cloned;
  }
  if (Array.isArray(error)) {
    return [...error];
  }
  return { ...(error as Record<string, unknown>) };
}

export function hasProviderErrorAlreadyReported(error: unknown): boolean {
  return Boolean(
    error
      && typeof error === 'object'
      && (error as { [PROVIDER_ERROR_REPORTED_MARKER]?: unknown })[PROVIDER_ERROR_REPORTED_MARKER] === true
  );
}

export function markProviderErrorAlreadyReported(error: unknown): void {
  if (!error || typeof error !== 'object') {
    return;
  }
  (error as { [PROVIDER_ERROR_REPORTED_MARKER]?: boolean })[PROVIDER_ERROR_REPORTED_MARKER] = true;
}

export function logNonBlockingError(stage: string, error: unknown, details?: Record<string, unknown>): void {
  const now = Date.now();
  const last = nonBlockingLogState.get(stage) ?? 0;
  if (now - last < NON_BLOCKING_LOG_THROTTLE_MS) {
    return;
  }
  nonBlockingLogState.set(stage, now);
  try {
    const detailSuffix = details && Object.keys(details).length > 0 ? ` details=${JSON.stringify(details)}` : '';
    console.warn(`[request-executor] ${stage} failed (non-blocking): ${formatUnknownError(error)}${detailSuffix}`);
  } catch {
    // Never throw from non-blocking logging.
  }
}

export function resetErrorReportStateForTests(): void {
  nonBlockingLogState.clear();
}
