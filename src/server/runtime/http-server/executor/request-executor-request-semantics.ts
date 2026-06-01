import { requireCoreDist } from '../../../../modules/llmswitch/bridge/module-loader.js';

type NativeChatProcessNodeResultSemanticsModule = {
  hasRequestedToolsInSemanticsWithNative?: (requestSemantics?: Record<string, unknown>) => boolean;
  isRequiredToolCallTurnWithNative?: (requestSemantics?: Record<string, unknown>) => boolean;
  isToolResultFollowupTurnWithNative?: (requestSemantics?: Record<string, unknown>) => boolean;
};

let cachedNativeSemantics: NativeChatProcessNodeResultSemanticsModule | null = null;

function getNativeSemantics(): NativeChatProcessNodeResultSemanticsModule {
  if (!cachedNativeSemantics) {
    cachedNativeSemantics = requireCoreDist<NativeChatProcessNodeResultSemanticsModule>(
      'router/virtual-router/engine-selection/native-chat-process-node-result-semantics'
    );
  }
  return cachedNativeSemantics;
}

export function hasRequestedToolsInSemantics(requestSemantics?: Record<string, unknown>): boolean {
  const fn = getNativeSemantics().hasRequestedToolsInSemanticsWithNative;
  if (typeof fn !== 'function') throw new Error('[request-semantics] hasRequestedToolsInSemanticsWithNative unavailable');
  return fn(requestSemantics);
}

export function isRequiredToolCallTurn(requestSemantics?: Record<string, unknown>): boolean {
  const fn = getNativeSemantics().isRequiredToolCallTurnWithNative;
  if (typeof fn !== 'function') throw new Error('[request-semantics] isRequiredToolCallTurnWithNative unavailable');
  return fn(requestSemantics);
}

export function isToolResultFollowupTurn(requestSemantics?: Record<string, unknown>): boolean {
  const fn = getNativeSemantics().isToolResultFollowupTurnWithNative;
  if (typeof fn !== 'function') throw new Error('[request-semantics] isToolResultFollowupTurnWithNative unavailable');
  return fn(requestSemantics);
}
