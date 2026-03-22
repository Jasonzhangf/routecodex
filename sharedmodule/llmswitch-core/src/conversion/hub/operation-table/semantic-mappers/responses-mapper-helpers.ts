import type {
  ChatEnvelope,
  ChatMessage,
  ChatSemantics,
  ChatToolDefinition,
  ChatToolOutput,
  MissingField,
} from '../../types/chat-envelope.js';
import { isJsonObject, jsonClone, type JsonObject, type JsonValue } from '../../types/json.js';
import type { ResponsesRequestContext } from '../../../responses/responses-openai-bridge.js';
import { maybeAugmentApplyPatchErrorContent } from './chat-mapper.js';
import {
  mapReqInboundBridgeToolsToChatWithNative
} from '../../../../router/virtual-router/engine-selection/native-hub-pipeline-req-inbound-semantics.js';
import type { ResponsesToolOutputEntry } from './responses-submit-tool-outputs.js';

export function mapToolOutputs(
  entries: ResponsesToolOutputEntry[] | undefined,
  missing: MissingField[],
): ChatToolOutput[] | undefined {
  if (!entries || !entries.length) return undefined;
  const outputs: ChatToolOutput[] = [];
  entries.forEach((entry, index) => {
    if (!isJsonObject(entry)) {
      missing.push({ path: `tool_outputs[${index}]`, reason: 'invalid_entry', originalValue: jsonClone(entry as JsonValue) });
      return;
    }
    const callId = entry.tool_call_id || entry.call_id || entry.id;
    if (!callId) {
      missing.push({ path: `tool_outputs[${index}].tool_call_id`, reason: 'missing_tool_call_id' });
      return;
    }
    let content = '';
    if (typeof entry.output === 'string') {
      content = entry.output;
    } else if (entry.output != null) {
      try {
        content = JSON.stringify(entry.output);
      } catch {
        content = String(entry.output);
      }
    }
    const nameValue = typeof entry.name === 'string' ? entry.name : undefined;
    const augmented = maybeAugmentApplyPatchErrorContent(content, nameValue);
    outputs.push({
      tool_call_id: String(callId),
      content: augmented,
      name: nameValue
    });
  });
  return outputs.length ? outputs : undefined;
}

export function normalizeTools(
  rawTools: JsonValue[] | undefined,
  missing: MissingField[],
): ChatToolDefinition[] | undefined {
  if (!rawTools || rawTools.length === 0) {
    return undefined;
  }
  const tools = mapReqInboundBridgeToolsToChatWithNative(rawTools as unknown[]) as unknown as ChatToolDefinition[];
  if (tools.length === 0) {
    rawTools.forEach((tool, index) => {
      missing.push({ path: `tools[${index}]`, reason: 'invalid_entry', originalValue: jsonClone(tool as JsonValue) });
    });
  }
  return tools.length ? tools : undefined;
}

export function normalizeMessages(
  value: JsonValue | undefined,
  missing: MissingField[],
): ChatEnvelope['messages'] {
  if (!Array.isArray(value)) {
    if (value !== undefined) {
      missing.push({ path: 'messages', reason: 'invalid_type', originalValue: jsonClone(value) });
    } else {
      missing.push({ path: 'messages', reason: 'absent' });
    }
    return [];
  }
  const messages: ChatEnvelope['messages'] = [];
  value.forEach((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      missing.push({ path: `messages[${index}]`, reason: 'invalid_entry', originalValue: jsonClone(item as JsonValue) });
      return;
    }
    messages.push(item as ChatEnvelope['messages'][number]);
  });
  return messages;
}

export function serializeSystemContent(message: ChatMessage): string | undefined {
  if (!message) return undefined;
  const content = message.content as unknown;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    content.forEach(part => {
      if (typeof part === 'string') {
        parts.push(part);
      } else if (part && typeof part === 'object') {
        const text = (part as JsonObject).text;
        if (typeof text === 'string') {
          parts.push(text);
        }
      }
    });
    return parts.join('');
  }
  if (content != null) {
    try {
      return JSON.stringify(content);
    } catch {
      return String(content);
    }
  }
  return undefined;
}

function mergeMetadata(a?: JsonObject, b?: JsonObject): JsonObject | undefined {
  if (!a && !b) {
    return undefined;
  }
  if (!a && b) {
    return jsonClone(b) as JsonObject;
  }
  if (a && !b) {
    return jsonClone(a) as JsonObject;
  }
  const left = jsonClone(a as JsonObject) as JsonObject;
  const right = jsonClone(b as JsonObject) as JsonObject;
  return { ...left, ...right };
}

export function attachResponsesSemantics(
  existing: ChatSemantics | undefined,
  context?: ResponsesRequestContext,
  resume?: JsonObject
): ChatSemantics | undefined {
  if (!context && !resume) {
    return existing;
  }
  const next: ChatSemantics = existing ? { ...existing } : {};
  const currentNode =
    next.responses && isJsonObject(next.responses) ? ({ ...(next.responses as JsonObject) } as JsonObject) : ({} as JsonObject);
  if (context) {
    currentNode.context = jsonClone(context as JsonObject);
  }
  if (resume) {
    currentNode.resume = jsonClone(resume);
  }
  next.responses = currentNode;
  return next;
}

function extractResponsesSemanticsNode(chat: ChatEnvelope): JsonObject | undefined {
  if (!chat?.semantics || typeof chat.semantics !== 'object') {
    return undefined;
  }
  const node = chat.semantics.responses;
  return node && isJsonObject(node) ? (node as JsonObject) : undefined;
}

function readResponsesContextFromSemantics(chat: ChatEnvelope): ResponsesRequestContext | undefined {
  const node = extractResponsesSemanticsNode(chat);
  if (!node) {
    return undefined;
  }
  const contextNode = node.context;
  if (!contextNode || !isJsonObject(contextNode)) {
    return undefined;
  }
  return jsonClone(contextNode as JsonObject) as ResponsesRequestContext;
}

export function selectResponsesContextSnapshot(
  chat: ChatEnvelope,
  envelopeMetadata?: JsonObject
): ResponsesRequestContext {
  const semanticsContext = readResponsesContextFromSemantics(chat);
  const context: ResponsesRequestContext =
    semanticsContext ??
    ({
      metadata: envelopeMetadata
    } as ResponsesRequestContext);
  const mergedMetadata = mergeMetadata(
    (context.metadata as JsonObject | undefined) ?? undefined,
    envelopeMetadata
  );
  if (mergedMetadata) {
    context.metadata = mergedMetadata;
  }
  return context;
}
