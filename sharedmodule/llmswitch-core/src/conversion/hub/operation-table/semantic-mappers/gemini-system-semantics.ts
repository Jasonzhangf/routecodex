import type { ChatEnvelope } from '../../types/chat-envelope.js';
import { isJsonObject, jsonClone, type JsonObject, type JsonValue } from '../../types/json.js';

export function ensureSystemSemantics(chat: ChatEnvelope): JsonObject {
  if (!chat.semantics || typeof chat.semantics !== 'object') {
    chat.semantics = {};
  }
  if (!chat.semantics.system || !isJsonObject(chat.semantics.system)) {
    chat.semantics.system = {};
  }
  return chat.semantics.system as JsonObject;
}

export function readSystemTextBlocksFromSemantics(chat: ChatEnvelope): string[] | undefined {
  if (!chat.semantics || typeof chat.semantics !== 'object') {
    return undefined;
  }
  const systemNode = chat.semantics.system;
  if (!systemNode || !isJsonObject(systemNode)) {
    return undefined;
  }
  const rawBlocks = (systemNode as JsonObject).textBlocks;
  if (!Array.isArray(rawBlocks)) {
    return undefined;
  }
  const normalized = rawBlocks
    .map((entry) => (typeof entry === 'string' ? entry : undefined))
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  return normalized.length ? normalized : undefined;
}

export function collectSystemSegments(systemInstruction: JsonValue | undefined): string[] {
  if (!systemInstruction) return [];
  const flatten = (val: JsonValue): string => {
    if (typeof val === 'string') return val;
    if (Array.isArray(val)) return val.map((entry) => flatten(entry as JsonValue)).filter(Boolean).join('\n');
    if (val && typeof val === 'object') {
      const text = (val as JsonObject).text;
      if (typeof text === 'string') return text;
      const parts = (val as JsonObject).parts;
      if (Array.isArray(parts)) return parts.map((entry) => flatten(entry as JsonValue)).filter(Boolean).join('\n');
    }
    return '';
  };
  const text = flatten(systemInstruction).trim();
  return text ? [text] : [];
}

export function applyGeminiRequestSystemInstruction(args: {
  request: Record<string, unknown>;
  semanticsSystemInstruction?: JsonValue;
  protocolStateSystemInstruction?: JsonValue;
  systemTextBlocksFromSemantics?: string[];
}): void {
  const {
    request,
    semanticsSystemInstruction,
    protocolStateSystemInstruction,
    systemTextBlocksFromSemantics
  } = args;

  if (semanticsSystemInstruction !== undefined) {
    request.systemInstruction = jsonClone(semanticsSystemInstruction);
    return;
  }
  if (protocolStateSystemInstruction !== undefined) {
    request.systemInstruction = jsonClone(protocolStateSystemInstruction);
    return;
  }
  const fallbackSystemInstructions = systemTextBlocksFromSemantics;
  if (fallbackSystemInstructions && fallbackSystemInstructions.length) {
    const sysBlocks = fallbackSystemInstructions
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .map((value) => ({ text: value }));
    if (sysBlocks.length) {
      request.systemInstruction = { role: 'system', parts: sysBlocks };
    }
  }
}
