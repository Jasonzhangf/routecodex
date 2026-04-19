import type { ChatEnvelope, ChatSemantics } from '../../types/chat-envelope.js';
import { isJsonObject, jsonClone, type JsonObject, type JsonValue } from '../../types/json.js';
import {
  appendDroppedFieldAudit as appendDroppedFieldAuditShared,
  appendLossyFieldAudit as appendLossyFieldAuditShared,
  appendPreservedFieldAudit as appendPreservedFieldAuditShared,
  appendUnsupportedFieldAudit as appendUnsupportedFieldAuditShared,
} from './protocol-mapping-audit.js';

export function ensureSemantics(chat: ChatEnvelope): ChatSemantics {
  if (!chat.semantics || typeof chat.semantics !== 'object') {
    chat.semantics = {};
  }
  return chat.semantics;
}

export function ensureToolsSemanticsNode(chat: ChatEnvelope): JsonObject {
  const semantics = ensureSemantics(chat);
  if (!semantics.tools || !isJsonObject(semantics.tools)) {
    semantics.tools = {};
  }
  return semantics.tools as JsonObject;
}

export function ensureAnthropicSemanticsNode(chat: ChatEnvelope): JsonObject {
  const semantics = ensureSemantics(chat);
  if (!semantics.anthropic || !isJsonObject(semantics.anthropic)) {
    semantics.anthropic = {};
  }
  return semantics.anthropic as JsonObject;
}

export function markExplicitEmptyTools(chat: ChatEnvelope): void {
  const semantics = ensureSemantics(chat);
  if (!semantics.tools || !isJsonObject(semantics.tools)) {
    semantics.tools = {};
  }
  (semantics.tools as JsonObject).explicitEmpty = true;
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

export function cloneAnthropicSystemBlocks(value: JsonValue | undefined): JsonValue[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const blocks = Array.isArray(value) ? value : [value];
  if (!blocks.length) {
    return undefined;
  }
  return blocks.map((entry) => jsonClone(entry as JsonValue)) as JsonValue[];
}

export function isResponsesOrigin(chat: ChatEnvelope): boolean {
  const semantics = chat?.semantics as Record<string, unknown> | undefined;
  if (semantics && semantics.responses && isJsonObject(semantics.responses as JsonValue)) {
    return true;
  }
  const ctx = chat?.metadata && typeof chat.metadata === 'object'
    ? ((chat.metadata as Record<string, unknown>).context as Record<string, unknown> | undefined)
    : undefined;
  const protocol = typeof ctx?.providerProtocol === 'string' ? ctx.providerProtocol.trim().toLowerCase() : '';
  if (protocol === 'openai-responses') {
    return true;
  }
  const endpoint = typeof ctx?.entryEndpoint === 'string' ? ctx.entryEndpoint.trim().toLowerCase() : '';
  return endpoint === '/v1/responses';
}

export function appendDroppedFieldAudit(chat: ChatEnvelope, options: {
  field: string;
  targetProtocol: string;
  reason: string;
}): void {
  appendDroppedFieldAuditShared(chat, options);
}

export function appendLossyFieldAudit(chat: ChatEnvelope, options: {
  field: string;
  targetProtocol: string;
  reason: string;
}): void {
  appendLossyFieldAuditShared(chat, options);
}

export function appendPreservedFieldAudit(chat: ChatEnvelope, options: {
  field: string;
  targetProtocol: string;
  reason: string;
}): void {
  appendPreservedFieldAuditShared(chat, options);
}

export function appendUnsupportedFieldAudit(chat: ChatEnvelope, options: {
  field: string;
  targetProtocol?: string;
  reason: string;
}): void {
  appendUnsupportedFieldAuditShared(chat, options);
}
