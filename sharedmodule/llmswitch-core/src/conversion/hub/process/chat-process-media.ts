import {
  analyzeChatProcessMedia,
  stripChatProcessHistoricalImages,
} from "../../../router/virtual-router/engine-selection/native-router-hotpath.js";
import type { StandardizedMessage } from "../types/standardized.js";

export function stripHistoricalImageAttachments(
  messages: StandardizedMessage[],
): StandardizedMessage[] {
  if (!Array.isArray(messages) || !messages.length) {
    return messages;
  }

  const placeholderText = "[Image omitted]";
  const stripped = stripChatProcessHistoricalImages(
    messages as unknown[],
    placeholderText,
  );
  if (stripped.changed !== true || !Array.isArray(stripped.messages)) {
    return messages;
  }
  return stripped.messages as StandardizedMessage[];
}

const INLINE_MEDIA_DATA_RE =
  /data:(image|video)\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]+/i;

function isVisualToolMessage(message: StandardizedMessage): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  if (message.role !== "tool") {
    return false;
  }
  const name =
    typeof message.name === "string" ? message.name.trim().toLowerCase() : "";
  if (name === "view_image") {
    return true;
  }
  const content = typeof message.content === "string" ? message.content : "";
  return INLINE_MEDIA_DATA_RE.test(content);
}

export function stripHistoricalVisualToolOutputs(
  messages: StandardizedMessage[],
): StandardizedMessage[] {
  if (!Array.isArray(messages) || messages.length === 0) {
    return messages;
  }

  let changed = false;
  const next = messages.map((message) => {
    if (!isVisualToolMessage(message)) {
      return message;
    }
    const content = typeof message.content === "string" ? message.content : "";
    if (!INLINE_MEDIA_DATA_RE.test(content)) {
      return message;
    }
    changed = true;
    return {
      ...message,
      content: "[Image omitted]",
    };
  });

  return changed ? next : messages;
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
  if (!Array.isArray(messages) || messages.length === 0) {
    return messages;
  }

  const toolCallIdsWithResponse = new Set<string>();
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role === "tool" && typeof msg.tool_call_id === "string") {
      toolCallIdsWithResponse.add(msg.tool_call_id);
    }
  }

  const result: StandardizedMessage[] = [];
  let changed = false;

  for (const msg of messages) {
    if (msg?.role === "assistant" && Array.isArray(msg.tool_calls)) {
      const completeToolCalls: typeof msg.tool_calls = [];
      const missingToolCallIds: string[] = [];

      for (const tc of msg.tool_calls) {
        const tcId = typeof tc?.id === "string" ? tc.id : "";
        if (tcId && toolCallIdsWithResponse.has(tcId)) {
          completeToolCalls.push(tc);
        } else if (tcId) {
          missingToolCallIds.push(tcId);
        }
      }

      if (missingToolCallIds.length > 0) {
        changed = true;
        const repaired: StandardizedMessage = {
          ...msg,
          tool_calls:
            completeToolCalls.length > 0 ? completeToolCalls : undefined,
        };
        if (!repaired.tool_calls) {
          delete (repaired as any).tool_calls;
        }
        result.push(repaired);

        for (const missingId of missingToolCallIds) {
          result.push({
            role: "tool",
            tool_call_id: missingId,
            content: '{"status":"tool_call_repaired_orphaned_tool_call"}',
          } as StandardizedMessage);
        }
      } else {
        result.push(msg);
      }
    } else {
      result.push(msg);
    }
  }

  return changed ? result : messages;
}
