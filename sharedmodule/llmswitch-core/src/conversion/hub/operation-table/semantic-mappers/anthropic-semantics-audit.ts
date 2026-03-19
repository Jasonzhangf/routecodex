import type { ChatEnvelope, ChatSemantics } from '../../types/chat-envelope.js';
import { isJsonObject, jsonClone, type JsonObject, type JsonValue } from '../../types/json.js';

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

function appendMappingAudit(chat: ChatEnvelope, options: {
  bucket: 'dropped' | 'lossy';
  field: string;
  targetProtocol: string;
  reason: string;
  source?: string;
}): void {
  const metadata = chat.metadata && typeof chat.metadata === 'object'
    ? (chat.metadata as Record<string, unknown>)
    : ((chat.metadata = { context: (chat.metadata as any)?.context ?? {} } as any) as unknown as Record<string, unknown>);
  const root =
    metadata.mappingAudit && typeof metadata.mappingAudit === 'object' && !Array.isArray(metadata.mappingAudit)
      ? (metadata.mappingAudit as Record<string, unknown>)
      : ((metadata.mappingAudit = {}) as Record<string, unknown>);
  const current = Array.isArray(root[options.bucket]) ? (root[options.bucket] as Array<Record<string, unknown>>) : [];
  const duplicate = current.find((entry) =>
    entry &&
    entry.field === options.field &&
    entry.targetProtocol === options.targetProtocol &&
    entry.reason === options.reason
  );
  if (!duplicate) {
    current.push({
      field: options.field,
      source: options.source ?? 'chat.parameters',
      targetProtocol: options.targetProtocol,
      reason: options.reason
    });
  }
  root[options.bucket] = current as unknown as JsonValue;
}

export function appendDroppedFieldAudit(chat: ChatEnvelope, options: {
  field: string;
  targetProtocol: string;
  reason: string;
}): void {
  appendMappingAudit(chat, {
    bucket: 'dropped',
    ...options
  });
}

export function appendLossyFieldAudit(chat: ChatEnvelope, options: {
  field: string;
  targetProtocol: string;
  reason: string;
}): void {
  appendMappingAudit(chat, {
    bucket: 'lossy',
    ...options
  });
}
