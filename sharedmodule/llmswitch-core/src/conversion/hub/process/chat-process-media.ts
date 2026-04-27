import {
  analyzeChatProcessMedia,
} from "../../../router/virtual-router/engine-selection/native-router-hotpath.js";
import type { StandardizedMessage } from "../types/standardized.js";

export function stripHistoricalImageAttachments(
  messages: StandardizedMessage[],
): StandardizedMessage[] {
  return messages;
}

export function stripHistoricalVisualToolOutputs(
  messages: StandardizedMessage[],
): StandardizedMessage[] {
  return messages;
}

export function containsImageAttachment(
  messages: StandardizedMessage[],
): boolean {
  if (!Array.isArray(messages) || !messages.length) {
    return false;
  }
  return analyzeChatProcessMedia(messages).containsCurrentTurnImage === true;
}

export function repairIncompleteToolCalls(
  messages: StandardizedMessage[],
): StandardizedMessage[] {
  return messages;
}
