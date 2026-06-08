/**
 * Native Failure Policy Bridge
 *
 * Thin wrappers around llmswitch-core native Rust failure_policy module.
 * Single source of truth for provider failure classification/retry/backoff.
 */

import {
  failNativeRequired,
} from './native-router-hotpath-policy.js';
import { loadNativeRouterHotpathBinding } from './native-router-hotpath-loader.js';

type NativeBinding = Record<string, unknown>;

function getBindingOrThrow(): NativeBinding {
  const binding = loadNativeRouterHotpathBinding();
  if (!binding) {
    throw failNativeRequired('failure-policy', 'native binding not loaded');
  }
  return binding;
}

export type FailureClassification = 'unrecoverable' | 'recoverable' | 'special_400';

export function classifyProviderFailure(
  statusCode: number | undefined,
  errorCode: string | undefined,
  upstreamCode: string | undefined,
  isNetworkError: boolean,
): FailureClassification {
  const binding = getBindingOrThrow();
  const fn = binding.classifyProviderFailureJson as (
    status: number | undefined,
    errorCode: string | undefined,
    upstreamCode: string | undefined,
    isNetworkError: boolean,
  ) => string;
  if (typeof fn !== 'function') {
    throw failNativeRequired('classifyProviderFailureJson');
  }
  return JSON.parse(fn(statusCode, errorCode, upstreamCode, isNetworkError));
}

export function isBlockingRecoverableNative(
  classification: FailureClassification,
  stage?: string,
): boolean {
  const binding = getBindingOrThrow();
  const fn = binding.isProviderFailureBlockingRecoverableJson as (
    classificationJson: string,
    stage: string | undefined,
  ) => boolean;
  if (typeof fn !== 'function') {
    throw failNativeRequired('isProviderFailureBlockingRecoverableJson');
  }
  return fn(JSON.stringify(classification), stage);
}

export function shouldRetryNative(
  classification: FailureClassification,
  attempt: number,
  maxAttempts: number,
): boolean {
  const binding = getBindingOrThrow();
  const fn = binding.shouldRetryProviderFailureJson as (
    classificationJson: string,
    attempt: number,
    maxAttempts: number,
  ) => boolean;
  if (typeof fn !== 'function') {
    throw failNativeRequired('shouldRetryProviderFailureJson');
  }
  return fn(JSON.stringify(classification), attempt, maxAttempts);
}

export function computeBackoffMsNative(
  classification: FailureClassification,
  attempt: number,
  baseMs: number,
  maxMs: number,
): number {
  const binding = getBindingOrThrow();
  const fn = binding.computeProviderBackoffMsJson as (
    classificationJson: string,
    attempt: number,
    baseMs: number,
    maxMs: number,
  ) => number;
  if (typeof fn !== 'function') {
    throw failNativeRequired('computeProviderBackoffMsJson');
  }
  return fn(JSON.stringify(classification), attempt, baseMs, maxMs);
}

export function getNetworkErrorCodes(): string[] {
  const binding = getBindingOrThrow();
  const fn = binding.networkErrorSetJson as () => string;
  if (typeof fn !== 'function') {
    throw failNativeRequired('networkErrorSetJson');
  }
  return JSON.parse(fn());
}
