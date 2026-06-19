import {
  resolveProviderRetryExecutionPolicyNative,
} from '../../../../modules/llmswitch/bridge/native-exports.js';

export type RequestExecutorNativeRetryPolicyInput = {
  classification: unknown;
  isStreamingRequest?: boolean;
  hostContractFailure?: boolean;
  forceExcludeCurrentProviderOnRetry?: boolean;
  errorCode?: string;
  promptTooLong?: boolean;
  existingExclusion?: boolean;
};

export type RequestExecutorNativeRetryPolicyDecision = {
  excludeCurrentProvider: boolean;
  reason: string;
};

export function resolveRequestExecutorNativeRetryPolicy(
  input: RequestExecutorNativeRetryPolicyInput
): RequestExecutorNativeRetryPolicyDecision {
  return resolveProviderRetryExecutionPolicyNative(input);
}
