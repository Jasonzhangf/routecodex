import { analyzeChatWebSearchIntent } from '../../../router/virtual-router/engine-selection/native-router-hotpath.js';
import { extractWebSearchSemanticsHintWithNative } from '../../../router/virtual-router/engine-selection/native-chat-process-web-search-intent-semantics.js';
import type { ChatSemantics } from '../types/chat-envelope.js';
import type { StandardizedRequest } from '../types/standardized.js';

export type WebSearchIntent = {
  hasIntent: boolean;
  googlePreferred: boolean;
};

export type WebSearchSemanticsHint = {
  force?: boolean;
  disable?: boolean;
};

export function extractWebSearchSemantics(semantics: ChatSemantics | undefined): WebSearchSemanticsHint | undefined {
  return extractWebSearchSemanticsHintWithNative(semantics) as WebSearchSemanticsHint | undefined;
}

export function detectWebSearchIntent(request: StandardizedRequest): WebSearchIntent {
  const messages = Array.isArray(request.messages) ? request.messages : [];
  const analysis = analyzeChatWebSearchIntent(messages);
  return {
    hasIntent: analysis.hasIntent === true,
    googlePreferred: analysis.googlePreferred === true
  };
}
