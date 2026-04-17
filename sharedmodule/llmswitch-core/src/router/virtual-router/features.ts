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

function getLatestResponsesContextMessage(
  request: StandardizedRequest | ProcessedRequest
): { role?: string; message?: StandardizedRequest['messages'][number] } | null {
  const contextInput = asRecord((request as { semantics?: unknown }).semantics)?.responses;
  const context = asRecord(contextInput)?.context;
  const input = Array.isArray(asRecord(context)?.input) ? (asRecord(context)?.input as unknown[]) : [];
  for (let idx = input.length - 1; idx >= 0; idx -= 1) {
    const entry = asRecord(input[idx]);
    if (!entry) {
      continue;
    }
    const entryType = typeof entry.type === 'string' && entry.type.trim()
      ? entry.type.trim().toLowerCase()
      : 'message';
    if (entryType !== 'message') {
      continue;
    }
    const role = typeof entry.role === 'string' && entry.role.trim()
      ? entry.role.trim().toLowerCase()
      : 'user';
    if (role !== 'user' && role !== 'assistant' && role !== 'tool') {
      continue;
    }
    const content = entry.content;
    if (typeof content !== 'string' && !Array.isArray(content)) {
      continue;
    }
    return {
      role,
      message: {
        role: role as 'user' | 'assistant' | 'tool',
        content: content as StandardizedRequest['messages'][number]['content']
      }
    };
  }
  return null;
}

function getResponsesContextInput(request: StandardizedRequest | ProcessedRequest): Record<string, unknown>[] {
  const contextInput = asRecord((request as { semantics?: unknown }).semantics)?.responses;
  const context = asRecord(contextInput)?.context;
  const input = Array.isArray(asRecord(context)?.input) ? (asRecord(context)?.input as unknown[]) : [];
  return input
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry));
}

function getResponsesContextToolSignals(request: StandardizedRequest | ProcessedRequest): {
  hasToolCallResponses: boolean;
  lastAssistantTool: ReturnType<typeof classifyToolCallForReport>;
} {
  const input = getResponsesContextInput(request);
  let lastAssistantTool: ReturnType<typeof classifyToolCallForReport>;
  let hasToolCallResponses = false;
  let seenLatestUser = false;

  for (let idx = input.length - 1; idx >= 0; idx -= 1) {
    const entry = input[idx];
    const entryType = typeof entry.type === 'string' ? entry.type.trim().toLowerCase() : '';
    const entryRole = typeof entry.role === 'string' ? entry.role.trim().toLowerCase() : '';
    if (!seenLatestUser) {
      if (entryType === 'message' && entryRole === 'user') {
        seenLatestUser = true;
      }
      continue;
    }
    if (entryType === 'message' && entryRole === 'user') {
      break;
    }
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

  const responsesLatestMessage = getLatestResponsesContextMessage(request);
  const latestMessageRole = responsesLatestMessage?.role || getLatestMessageRole(request.messages);
  const latestMessage = responsesLatestMessage?.message || (Array.isArray(request.messages) && request.messages.length
    ? request.messages[request.messages.length - 1]
    : undefined);
  const assistantMessages = request.messages.filter((msg) => msg.role === 'assistant');
  const responsesToolSignals = getResponsesContextToolSignals(request);
  const latestUserText = latestMessageRole === 'user' && latestMessage
    ? extractMessageText(latestMessage)
    : '';
  const normalizedUserText = latestUserText.toLowerCase();
  const meaningfulDeclaredTools = extractMeaningfulDeclaredToolNames(request.tools);
  const hasTools = meaningfulDeclaredTools.length > 0;
  const messageToolCallResponses = assistantMessages.some(
    (msg) => Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0
  );
  const hasToolCallResponses = messageToolCallResponses || responsesToolSignals.hasToolCallResponses;

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
  const lastAssistantTool = responsesToolSignals.lastAssistantTool || detectLastAssistantToolCategory(assistantMessages);
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
