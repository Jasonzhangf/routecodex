/**
 * Native Failure Policy Bridge
 *
 * Thin wrappers around llmswitch-core native Rust failure_policy module.
 * Single source of truth for provider failure classification/retry/backoff.
 */

import {
  failNativeRequired,
} from './native-router-hotpath-loader.js';
import { loadNativeRouterHotpathBinding } from './native-router-hotpath-loader.js';

type NativeBinding = Record<string, unknown>;

function getBindingOrThrow(): NativeBinding {
  const binding = loadNativeRouterHotpathBinding();
  if (!binding) {
    throw failNativeRequired('failure-policy', 'native binding not loaded');
  }
  return binding;
}

export type FailureClassification = 'unrecoverable' | 'recoverable';

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

export type ProviderRetryExecutionPolicyInput = {
  classification: FailureClassification;
  isStreamingRequest?: boolean;
  hostContractFailure?: boolean;
  forceExcludeCurrentProviderOnRetry?: boolean;
  promptTooLong?: boolean;
  existingExclusion?: boolean;
};

export type ProviderRetryExecutionPolicyDecision = {
  excludeCurrentProvider: boolean;
  reason: string;
};

export function resolveProviderRetryExecutionPolicyNative(
  input: ProviderRetryExecutionPolicyInput,
): ProviderRetryExecutionPolicyDecision {
  const binding = getBindingOrThrow();
  const fn = binding.resolveProviderRetryExecutionPolicyJson as (
    inputJson: string,
  ) => string;
  if (typeof fn !== 'function') {
    throw failNativeRequired('resolveProviderRetryExecutionPolicyJson');
  }
  return JSON.parse(fn(JSON.stringify(input))) as ProviderRetryExecutionPolicyDecision;
}

export function getNetworkErrorCodes(): string[] {
  const binding = getBindingOrThrow();
  const fn = binding.networkErrorSetJson as () => string;
  if (typeof fn !== 'function') {
    throw failNativeRequired('networkErrorSetJson');
  }
  return JSON.parse(fn());
}
