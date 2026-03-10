import { encoding_for_model, get_encoding, type Tiktoken, type TiktokenModel } from 'tiktoken';
import type { StandardizedMessage, StandardizedRequest, StandardizedTool } from '../../conversion/hub/types/standardized.js';

const DEFAULT_ENCODING = 'cl100k_base';

const encoderCache = new Map<string, Tiktoken>();
let defaultEncoder: Tiktoken | null = null;

function getEncoder(model?: string): Tiktoken {
  if (model) {
    const normalized = model.trim();
    if (encoderCache.has(normalized)) {
      return encoderCache.get(normalized)!;
    }
    try {
      const encoder = encoding_for_model(normalized as TiktokenModel);
      encoderCache.set(normalized, encoder);
      return encoder;
    } catch {
      // fall back to default encoder
    }
  }
  if (!defaultEncoder) {
    defaultEncoder = get_encoding(DEFAULT_ENCODING);
  }
  return defaultEncoder;
}

export function countRequestTokens(request: StandardizedRequest): number {
  const encoder = getEncoder(request.model);
  let total = 0;
  for (const message of request.messages || []) {
    total += countMessageTokens(message, encoder);
  }
  if (Array.isArray(request.tools)) {
    for (const tool of request.tools as StandardizedTool[]) {
      total += encodeText(JSON.stringify(tool ?? {}), encoder);
    }
  }
  if (request.parameters) {
    total += encodeText(JSON.stringify(request.parameters), encoder);
  }
  return total;
}

function countMessageTokens(message: StandardizedMessage, encoder: Tiktoken): number {
  let total = 0;
  total += encodeText(message.role, encoder);
  total += encodeContent(message.content, encoder);
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      total += encodeText(JSON.stringify(call ?? {}), encoder);
    }
  }
  if (message.name) {
    total += encodeText(message.name, encoder);
  }
  if (message.tool_call_id) {
    total += encodeText(message.tool_call_id, encoder);
  }
  return total;
}

type MediaKind = 'image' | 'video';

function detectMediaKind(record: Record<string, unknown>): MediaKind | null {
  const typeValue = typeof record.type === 'string' ? record.type.trim().toLowerCase() : '';
  if (typeValue.includes('video')) {
    return 'video';
  }
  if (typeValue.includes('image')) {
    return 'image';
  }
  if (Object.prototype.hasOwnProperty.call(record, 'video_url')) {
    return 'video';
  }
  if (Object.prototype.hasOwnProperty.call(record, 'image_url')) {
    return 'image';
  }
  const dataField = typeof record.data === 'string' ? record.data.trim().toLowerCase() : '';
  if (dataField.startsWith('data:video/')) {
    return 'video';
  }
  if (dataField.startsWith('data:image/')) {
    return 'image';
  }
  return null;
}

function parseStructuredContentString(raw: string): unknown | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  const likelyJson =
    (trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'));
  if (!likelyJson) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function encodeContent(content: StandardizedMessage['content'], encoder: Tiktoken): number {
  if (content === null || content === undefined) {
    return 0;
  }
  if (typeof content === 'string') {
    const structured = parseStructuredContentString(content);
    if (structured !== undefined) {
      return encodeContent(structured as StandardizedMessage['content'], encoder);
    }
    return encodeText(content, encoder);
  }
  if (Array.isArray(content)) {
    let total = 0;
    for (const part of content) {
      if (typeof part === 'string') {
        total += encodeText(part, encoder);
      } else if (part && typeof part === 'object') {
        const record = part as Record<string, unknown>;
        // Ignore image/video payload blocks in token estimation.
        if (detectMediaKind(record)) {
          continue;
        }
        if (typeof record.text === 'string') {
          total += encodeText(record.text, encoder);
        } else {
          total += encodeText(JSON.stringify(record), encoder);
        }
      }
    }
    return total;
  }
  if (typeof content === 'object') {
    const record = content as Record<string, unknown>;
    if (detectMediaKind(record)) {
      return 0;
    }
    return encodeText(JSON.stringify(content), encoder);
  }
  return encodeText(String(content), encoder);
}

function encodeText(value: unknown, encoder: Tiktoken): number {
  if (value === null || value === undefined) {
    return 0;
  }
  const text = typeof value === 'string' ? value : String(value);
  if (!text.trim()) {
    return 0;
  }
  return encoder.encode(text).length;
}
