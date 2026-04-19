import type {
  ProcessedRequest,
  StandardizedRequest
} from '../../conversion/hub/types/standardized.js';
import type { RouterMetadataInput, RoutingFeatures } from './types.js';
import {
  analyzeMediaAttachments,
  detectExtendedThinkingKeyword,
  detectKeyword,
  extractMessageText,
  getLatestMessageRole,
} from './message-utils.js';
import { extractAntigravityGeminiSessionIdWithNative } from './engine-selection/native-router-hotpath.js';
import {
  chooseHigherPriorityToolCategory,
  classifyToolCallForReport,
  detectCodingTool,
  detectLastAssistantToolCategory,
  detectVisionTool,
  detectWebSearchToolDeclared, detectWebTool,
  extractMeaningfulDeclaredToolNames
} from './tool-signals.js';
import { computeRequestTokens } from './token-estimator.js';

const THINKING_KEYWORDS = ['let me think', 'chain of thought', 'cot', 'reason step', 'deliberate'];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function getResponsesContextInput(request: StandardizedRequest | ProcessedRequest): Record<string, unknown>[] {
  const contextInput = asRecord((request as { semantics?: unknown }).semantics)?.responses;
  const context = asRecord(contextInput)?.context;
  const input = Array.isArray(asRecord(context)?.input) ? (asRecord(context)?.input as unknown[]) : [];
  return input
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry));
}

type ContextRole = 'user' | 'assistant' | 'tool';
type MessageLike = StandardizedRequest['messages'][number];
type ToolSignalState = {
  latestRole?: ContextRole;
  latestMessage?: MessageLike;
  hasToolCallResponses: boolean;
  lastAssistantTool: ReturnType<typeof classifyToolCallForReport>;
};

function normalizeResponsesEntryType(entry: Record<string, unknown>): string {
  return typeof entry.type === 'string' && entry.type.trim()
    ? entry.type.trim().toLowerCase()
    : 'message';
}

function getResponsesMessageRole(entry: Record<string, unknown>): ContextRole | undefined {
  const role = typeof entry.role === 'string' && entry.role.trim()
    ? entry.role.trim().toLowerCase()
    : 'user';
  return role === 'user' || role === 'assistant' || role === 'tool'
    ? role
    : undefined;
}

function getResponsesEntryRole(entry: Record<string, unknown>): ContextRole | undefined {
  const entryType = normalizeResponsesEntryType(entry);
  if (entryType === 'message') {
    return getResponsesMessageRole(entry);
  }
  if (entryType === 'function_call') {
    return 'assistant';
  }
  if (
    entryType === 'function_call_output'
    || entryType === 'tool_result'
    || entryType === 'tool_message'
  ) {
    return 'tool';
  }
  return undefined;
}

function toResponsesContextMessage(
  entry: Record<string, unknown>,
  role: ContextRole | undefined
): MessageLike | undefined {
  if (!role || normalizeResponsesEntryType(entry) !== 'message') {
    return undefined;
  }
  const content = entry.content;
  if (typeof content !== 'string' && !Array.isArray(content)) {
    return undefined;
  }
  return {
    role,
    content: content as MessageLike['content']
  };
}

function collectResponsesToolSignals(entries: Record<string, unknown>[]): {
  hasToolCallResponses: boolean;
  lastAssistantTool: ReturnType<typeof classifyToolCallForReport>;
} {
  let lastAssistantTool: ReturnType<typeof classifyToolCallForReport>;
  let hasToolCallResponses = false;

  for (const entry of entries) {
    const entryType = normalizeResponsesEntryType(entry);
    if (
      entryType === 'function_call'
      || entryType === 'function_call_output'
      || entryType === 'tool_result'
      || entryType === 'tool_message'
    ) {
      hasToolCallResponses = true;
    }
    if (entryType !== 'function_call') {
      continue;
    }
    const toolName = typeof entry.name === 'string' ? entry.name.trim() : '';
    if (!toolName) {
      continue;
    }
    const candidate = classifyToolCallForReport({
      type: 'function',
      id: typeof entry.id === 'string' ? entry.id : undefined,
      function: {
        name: toolName,
        arguments:
          typeof entry.arguments === 'string' || typeof entry.arguments === 'object'
            ? entry.arguments
            : undefined
      }
    } as StandardizedRequest['messages'][number]['tool_calls'][number]);
    lastAssistantTool = chooseHigherPriorityToolCategory(lastAssistantTool, candidate);
  }

  return {
    hasToolCallResponses,
    lastAssistantTool
  };
}

function getResponsesContextTurnState(request: StandardizedRequest | ProcessedRequest): ToolSignalState {
  const input = getResponsesContextInput(request);
  let latestRole: ContextRole | undefined;
  let latestMessage: MessageLike | undefined;

  for (let idx = input.length - 1; idx >= 0; idx -= 1) {
    const entry = input[idx];
    const entryRole = getResponsesEntryRole(entry);
    if (!entryRole) {
      continue;
    }
    latestRole = entryRole;
    latestMessage = toResponsesContextMessage(entry, entryRole);
    break;
  }

  let latestUserIndex = -1;
  for (let idx = input.length - 1; idx >= 0; idx -= 1) {
    const entry = input[idx];
    if (normalizeResponsesEntryType(entry) === 'message' && getResponsesMessageRole(entry) === 'user') {
      latestUserIndex = idx;
      break;
    }
  }

  let segmentStart = 0;
  let segmentEnd = input.length;
  if (latestUserIndex >= 0) {
    if (latestRole === 'user') {
      let previousUserIndex = -1;
      for (let idx = latestUserIndex - 1; idx >= 0; idx -= 1) {
        const entry = input[idx];
        if (normalizeResponsesEntryType(entry) === 'message' && getResponsesMessageRole(entry) === 'user') {
          previousUserIndex = idx;
          break;
        }
      }
      segmentStart = previousUserIndex + 1;
      segmentEnd = latestUserIndex;
    } else {
      segmentStart = latestUserIndex + 1;
    }
  }

  const toolSignals = collectResponsesToolSignals(input.slice(segmentStart, segmentEnd));
  return {
    latestRole,
    latestMessage,
    ...toolSignals
  };
}

function getMessageTurnState(messages: StandardizedRequest['messages'] | undefined): ToolSignalState {
  const normalizedMessages = Array.isArray(messages) ? messages : [];
  const latestMessage = normalizedMessages.length
    ? normalizedMessages[normalizedMessages.length - 1]
    : undefined;
  const latestRole = latestMessage?.role === 'user' || latestMessage?.role === 'assistant' || latestMessage?.role === 'tool'
    ? latestMessage.role
    : undefined;

  let latestUserIndex = -1;
  for (let idx = normalizedMessages.length - 1; idx >= 0; idx -= 1) {
    if (normalizedMessages[idx]?.role === 'user') {
      latestUserIndex = idx;
      break;
    }
  }

  let segmentStart = 0;
  let segmentEnd = normalizedMessages.length;
  if (latestUserIndex >= 0) {
    if (latestRole === 'user') {
      let previousUserIndex = -1;
      for (let idx = latestUserIndex - 1; idx >= 0; idx -= 1) {
        if (normalizedMessages[idx]?.role === 'user') {
          previousUserIndex = idx;
          break;
        }
      }
      segmentStart = previousUserIndex + 1;
      segmentEnd = latestUserIndex;
    } else {
      segmentStart = latestUserIndex + 1;
    }
  }

  const assistantSegment: MessageLike[] = [];
  let hasToolCallResponses = false;
  for (const msg of normalizedMessages.slice(segmentStart, segmentEnd)) {
    if (msg.role === 'tool') {
      hasToolCallResponses = true;
      continue;
    }
    if (msg.role !== 'assistant') {
      continue;
    }
    assistantSegment.push(msg);
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      hasToolCallResponses = true;
    }
  }

  return {
    latestRole,
    latestMessage,
    hasToolCallResponses,
    lastAssistantTool: detectLastAssistantToolCategory(assistantSegment)
  };
}

export function buildRoutingFeatures(
  request: StandardizedRequest | ProcessedRequest,
  metadata: RouterMetadataInput
): RoutingFeatures {
  const antigravitySessionId = (() => {
    try {
      const messages = Array.isArray(request.messages) ? request.messages : [];
      const contents = messages.map((msg) => {
        const role = msg?.role === 'user' ? 'user' : 'assistant';
        const text = msg ? extractMessageText(msg) : '';
        return { role, parts: [{ text }] };
      });
      return extractAntigravityGeminiSessionIdWithNative({ contents });
    } catch {
      return undefined;
    }
  })();

  const messageTurnState = getMessageTurnState(request.messages);
  const responsesTurnState = getResponsesContextTurnState(request);
  const currentUserFromMessages = messageTurnState.latestRole === 'user';
  const currentUserFromResponses = !currentUserFromMessages && responsesTurnState.latestRole === 'user';
  const latestMessageRole = currentUserFromMessages || currentUserFromResponses
    ? 'user'
    : responsesTurnState.latestRole || messageTurnState.latestRole || getLatestMessageRole(request.messages);
  const latestMessage = currentUserFromMessages
    ? messageTurnState.latestMessage
    : currentUserFromResponses
      ? responsesTurnState.latestMessage
      : responsesTurnState.latestMessage || messageTurnState.latestMessage;
  const latestUserText = latestMessageRole === 'user' && latestMessage
    ? extractMessageText(latestMessage)
    : '';
  const normalizedUserText = latestUserText.toLowerCase();
  const meaningfulDeclaredTools = extractMeaningfulDeclaredToolNames(request.tools);
  const hasTools = meaningfulDeclaredTools.length > 0;
  const hasToolCallResponses = currentUserFromMessages
    ? messageTurnState.hasToolCallResponses
    : currentUserFromResponses
      ? responsesTurnState.hasToolCallResponses
      : responsesTurnState.latestRole
        ? responsesTurnState.hasToolCallResponses
        : messageTurnState.hasToolCallResponses;

  const estimatedTokens = computeRequestTokens(request, latestUserText);
  const hasThinking = detectKeyword(normalizedUserText, THINKING_KEYWORDS);
  const hasVisionTool = detectVisionTool(request);
  // Media-driven multimodal routing must only trigger for the current user turn (latest message),
  // not for historical user messages carrying images during tool/assistant followups.
  const mediaSignals =
    latestMessageRole === 'user' ? analyzeMediaAttachments(latestMessage) : analyzeMediaAttachments(undefined);
  const hasImageAttachment = mediaSignals.hasAnyMedia;
  const hasCodingTool = detectCodingTool(request);
  const hasWebTool = detectWebTool(request);
  const hasThinkingKeyword = hasThinking || detectExtendedThinkingKeyword(normalizedUserText);
  const lastAssistantTool = currentUserFromMessages
    ? messageTurnState.lastAssistantTool
    : currentUserFromResponses
      ? responsesTurnState.lastAssistantTool
      : responsesTurnState.lastAssistantTool || messageTurnState.lastAssistantTool;
  const lastAssistantToolLabel = (() => {
    if (!lastAssistantTool) {
      return undefined;
    }
    if (lastAssistantTool.commandSnippet && lastAssistantTool.commandSnippet.trim()) {
      return lastAssistantTool.commandSnippet.trim();
    }
    if (lastAssistantTool.name && lastAssistantTool.name.trim()) {
      return lastAssistantTool.name.trim();
    }
    return undefined;
  })();

  return {
    requestId: metadata.requestId,
    model: request.model,
    totalMessages: request.messages?.length ?? 0,
    userTextSample: latestUserText.slice(0, 2000),
    toolCount: meaningfulDeclaredTools.length,
    hasTools,
    hasToolCallResponses,
    hasVisionTool,
    hasImageAttachment,
    hasVideoAttachment: mediaSignals.hasVideo,
    hasRemoteVideoAttachment: mediaSignals.hasRemoteVideo,
    hasLocalVideoAttachment: mediaSignals.hasLocalVideo,
    hasWebTool,
    hasWebSearchToolDeclared: detectWebSearchToolDeclared(request),
    hasCodingTool,
    hasThinkingKeyword,
    estimatedTokens,
    lastAssistantToolCategory: lastAssistantTool?.category,
    lastAssistantToolSnippet: lastAssistantTool?.commandSnippet,
    lastAssistantToolLabel,
    latestMessageFromUser: latestMessageRole === 'user',
    metadata: {
      ...metadata,
      ...(antigravitySessionId ? { antigravitySessionId } : {})
    }
  };
}
