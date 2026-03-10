import { normalizeChatMessageContentWithNative } from '../../router/virtual-router/engine-selection/native-shared-conversion-semantics.js';

function assertChatOutputNormalizerNativeAvailable(): void {
  if (typeof normalizeChatMessageContentWithNative !== 'function') {
    throw new Error('[chat-output-normalizer] native bindings unavailable');
  }
}

export function normalizeChatMessageContent(
  content: unknown
): { contentText?: string; reasoningText?: string } {
  assertChatOutputNormalizerNativeAvailable();
  return normalizeChatMessageContentWithNative(content);
}
