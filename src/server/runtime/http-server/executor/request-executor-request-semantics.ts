import {
  hasRequestedToolsInSemanticsNative,
  isRequiredToolCallTurnNative,
  isToolResultFollowupTurnNative,
  isProviderNativeResumeContinuationNative
} from '../../../../modules/llmswitch/bridge/native-exports.js';

export async function hasRequestedToolsInSemantics(requestSemantics?: Record<string, unknown>): Promise<boolean> {
  return hasRequestedToolsInSemanticsNative(requestSemantics);
}

export async function isRequiredToolCallTurn(requestSemantics?: Record<string, unknown>): Promise<boolean> {
  return isRequiredToolCallTurnNative(requestSemantics);
}

export async function isToolResultFollowupTurn(requestSemantics?: Record<string, unknown>): Promise<boolean> {
  return isToolResultFollowupTurnNative(requestSemantics);
}

export async function isProviderNativeResumeContinuation(requestSemantics?: Record<string, unknown>): Promise<boolean> {
  return isProviderNativeResumeContinuationNative(requestSemantics);
}
