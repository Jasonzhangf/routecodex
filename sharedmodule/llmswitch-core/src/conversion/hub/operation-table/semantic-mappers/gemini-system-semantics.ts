import type { ChatEnvelope } from '../../types/chat-envelope.js';
import { isJsonObject, jsonClone, type JsonObject, type JsonValue } from '../../types/json.js';
import { ANTIGRAVITY_SYSTEM_INSTRUCTION } from './gemini-antigravity-request.js';

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
  isAntigravityProvider: boolean;
  semanticsSystemInstruction?: JsonValue;
  protocolStateSystemInstruction?: JsonValue;
  systemTextBlocksFromSemantics?: string[];
}): void {
  const {
    request,
    isAntigravityProvider,
    semanticsSystemInstruction,
    protocolStateSystemInstruction,
    systemTextBlocksFromSemantics
  } = args;

  if (!isAntigravityProvider && semanticsSystemInstruction !== undefined) {
    request.systemInstruction = jsonClone(semanticsSystemInstruction);
    return;
  }
  if (!isAntigravityProvider && protocolStateSystemInstruction !== undefined) {
    request.systemInstruction = jsonClone(protocolStateSystemInstruction);
    return;
  }
  if (!isAntigravityProvider) {
    const fallbackSystemInstructions = systemTextBlocksFromSemantics;
    if (fallbackSystemInstructions && fallbackSystemInstructions.length) {
      const sysBlocks = fallbackSystemInstructions
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .map((value) => ({ text: value }));
      if (sysBlocks.length) {
        request.systemInstruction = { role: 'system', parts: sysBlocks };
      }
    }
    return;
  }

  const extraSegments: string[] = [];
  const seen = new Set<string>();
  const pushSegment = (value: string): void => {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (!trimmed) return;
    if (seen.has(trimmed)) return;
    seen.add(trimmed);
    extraSegments.push(trimmed);
  };

  for (const seg of collectSystemSegments(semanticsSystemInstruction)) {
    pushSegment(seg);
  }
  for (const seg of collectSystemSegments(protocolStateSystemInstruction)) {
    pushSegment(seg);
  }
  for (const seg of systemTextBlocksFromSemantics || []) {
    if (typeof seg === 'string') {
      pushSegment(seg);
    }
  }

  if (extraSegments.length > 0) {
    const [first, ...rest] = extraSegments;
    request.systemInstruction = {
      role: 'user',
      parts: [{ text: `${ANTIGRAVITY_SYSTEM_INSTRUCTION}\n\n${first}` }, ...rest.map((text) => ({ text }))]
    };
    return;
  }

  request.systemInstruction = {
    role: 'user',
    parts: [{ text: ANTIGRAVITY_SYSTEM_INSTRUCTION }]
  };
}
