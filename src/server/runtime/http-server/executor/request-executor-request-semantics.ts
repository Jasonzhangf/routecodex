import {
  hasRequestedToolsInSemanticsWithNative,
  isRequiredToolCallTurnWithNative,
  isToolResultFollowupTurnWithNative
} from '../../../../../sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-chat-process-node-result-semantics.js';

export function hasRequestedToolsInSemantics(requestSemantics?: Record<string, unknown>): boolean {
  return hasRequestedToolsInSemanticsWithNative(requestSemantics);
}

export function isRequiredToolCallTurn(requestSemantics?: Record<string, unknown>): boolean {
  return isRequiredToolCallTurnWithNative(requestSemantics);
}

export function isToolResultFollowupTurn(requestSemantics?: Record<string, unknown>): boolean {
  return isToolResultFollowupTurnWithNative(requestSemantics);
}
