import type { StandardizedRequest } from '../types/standardized.js';
import { stripGenericMarkersFromRequest } from './chat-process-generic-marker-strip.js';
import { sanitizeChatProcessMessagesWithNative } from '../../../router/virtual-router/engine-selection/native-router-hotpath.js';

export function sanitizeChatProcessRequest(
  request: StandardizedRequest
): StandardizedRequest {
  const sanitized = stripGenericMarkersFromRequest(request);
  if (!Array.isArray(sanitized.messages) || !sanitized.messages.length) {
    return sanitized;
  }

  const nativeResult = sanitizeChatProcessMessagesWithNative(
    sanitized as unknown as Record<string, unknown>
  );

  const nextRequest: StandardizedRequest = {
    ...sanitized,
    messages: nativeResult.messages as unknown as StandardizedRequest['messages']
  };

  if (nativeResult.removedAssistantTurns > 0 || nativeResult.didMutateMessageShapes) {
    nextRequest.metadata = {
      ...sanitized.metadata,
      chatProcessSanitizer: {
        removedAssistantTurns: nativeResult.removedAssistantTurns,
        removedEmptyAssistantTurns: nativeResult.removedEmptyAssistantTurns,
        removedTemplateAssistantTurns: nativeResult.removedTemplateAssistantTurns,
        removedDuplicateMirrorAssistantTurns: nativeResult.removedDuplicateMirrorAssistantTurns,
        removedHistoricalGoalTurns: (nativeResult as { removedHistoricalGoalTurns?: number }).removedHistoricalGoalTurns ?? 0,
        removedToolTurns: 0,
        removedEmptyToolTurns: 0,
        removedOrphanToolTurns: 0,
        backfilledToolCallIds: 0
      }
    };
  }

  return nextRequest;
}
