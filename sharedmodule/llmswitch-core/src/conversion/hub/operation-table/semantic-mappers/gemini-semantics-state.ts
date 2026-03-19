import type { ChatEnvelope } from '../../types/chat-envelope.js';
import { isJsonObject, type JsonObject } from '../../types/json.js';

export function ensureGeminiSemanticsNode(chat: ChatEnvelope): JsonObject {
  if (!chat.semantics || typeof chat.semantics !== 'object') {
    chat.semantics = {};
  }
  if (!chat.semantics.gemini || !isJsonObject(chat.semantics.gemini)) {
    chat.semantics.gemini = {};
  }
  return chat.semantics.gemini as JsonObject;
}

export function markGeminiExplicitEmptyTools(chat: ChatEnvelope): void {
  if (!chat.semantics || typeof chat.semantics !== 'object') {
    chat.semantics = {};
  }
  if (!chat.semantics.tools || !isJsonObject(chat.semantics.tools)) {
    chat.semantics.tools = {};
  }
  (chat.semantics.tools as JsonObject).explicitEmpty = true;
}

export function readGeminiSemantics(chat: ChatEnvelope): JsonObject | undefined {
  if (!chat.semantics || typeof chat.semantics !== 'object') {
    return undefined;
  }
  const node = chat.semantics.gemini;
  return node && isJsonObject(node) ? (node as JsonObject) : undefined;
}

export function hasExplicitEmptyToolsSemantics(chat: ChatEnvelope): boolean {
  if (!chat.semantics || typeof chat.semantics !== 'object') {
    return false;
  }
  const toolsNode = chat.semantics.tools;
  if (!toolsNode || !isJsonObject(toolsNode)) {
    return false;
  }
  return Boolean((toolsNode as Record<string, unknown>).explicitEmpty);
}
