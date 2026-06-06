import { importCoreDist } from '../../../../modules/llmswitch/bridge/module-loader.js';

type NativeChatProcessNodeResultSemanticsModule = {
  hasRequestedToolsInSemanticsWithNative?: (requestSemantics?: Record<string, unknown>) => boolean;
  isRequiredToolCallTurnWithNative?: (requestSemantics?: Record<string, unknown>) => boolean;
  isToolResultFollowupTurnWithNative?: (requestSemantics?: Record<string, unknown>) => boolean;
};

let cachedNativeSemanticsPromise: Promise<NativeChatProcessNodeResultSemanticsModule> | null = null;

async function getNativeSemantics(): Promise<NativeChatProcessNodeResultSemanticsModule> {
  if (!cachedNativeSemanticsPromise) {
    cachedNativeSemanticsPromise = importCoreDist<NativeChatProcessNodeResultSemanticsModule>(
      'router/virtual-router/engine-selection/native-chat-process-node-result-semantics'
    );
  }
  return cachedNativeSemanticsPromise;
}

export async function hasRequestedToolsInSemantics(requestSemantics?: Record<string, unknown>): Promise<boolean> {
  const fn = (await getNativeSemantics()).hasRequestedToolsInSemanticsWithNative;
  if (typeof fn !== 'function') throw new Error('[request-semantics] hasRequestedToolsInSemanticsWithNative unavailable');
  return fn(requestSemantics);
}

export async function isRequiredToolCallTurn(requestSemantics?: Record<string, unknown>): Promise<boolean> {
  const fn = (await getNativeSemantics()).isRequiredToolCallTurnWithNative;
  if (typeof fn !== 'function') throw new Error('[request-semantics] isRequiredToolCallTurnWithNative unavailable');
  return fn(requestSemantics);
}

export async function isToolResultFollowupTurn(requestSemantics?: Record<string, unknown>): Promise<boolean> {
  const fn = (await getNativeSemantics()).isToolResultFollowupTurnWithNative;
  if (typeof fn !== 'function') throw new Error('[request-semantics] isToolResultFollowupTurnWithNative unavailable');
  return fn(requestSemantics);
}
