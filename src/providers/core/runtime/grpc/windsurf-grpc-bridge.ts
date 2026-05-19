/**
 * Windsurf gRPC Bridge — OpenAI Chat JSON ↔ LS gRPC/Protobuf.
 *
 * Architecture:
 *   Hub Pipeline (OpenAI Chat JSON)
 *     → WindsurfGrpcBridge.buildRequest()  [JSON → Protobuf]
 *     → LS gRPC stream (RawGetChatMessage)
 *     → WindsurfGrpcBridge.parseChunk()     [Protobuf → SSE events]
 *     → SSE stream back to Hub Pipeline
 *
 * Based on WindsurfAPI/src/windsurf.js + src/client.js (Apache-2.0).
 */

import { randomUUID } from 'crypto';
import { platform, arch } from 'os';
import {
  writeVarintField, writeStringField, writeMessageField,
  parseFields, getField,
} from './proto.js';
import { grpcFrame, grpcStream, LS_SERVICE } from './grpc-client.js';

const _os = platform() === 'darwin' ? 'macos' : platform() === 'win32' ? 'windows' : 'linux';
const _hw = arch() === 'arm64' ? 'arm64' : 'x86_64';
const DEFAULT_CLIENT_VERSION = '2.0.67';

// ─── Source enums (from Proto) ────────────────────────────
const SOURCE = { USER: 1, SYSTEM: 2, ASSISTANT: 3, TOOL: 4 };

// ─── Timestamp ─────────────────────────────────────────────
function encodeTimestamp(): Buffer {
  const now = Date.now();
  const secs = Math.floor(now / 1000);
  const nanos = (now % 1000) * 1_000_000;
  const parts = [writeVarintField(1, secs)];
  if (nanos > 0) parts.push(writeVarintField(2, nanos));
  return Buffer.concat(parts);
}

// ─── Metadata ─────────────────────────────────────────────
function buildMetadata(apiKey: string, sessionId: string | null = null): Buffer {
  return Buffer.concat([
    writeStringField(1, 'windsurf'),
    writeStringField(2, DEFAULT_CLIENT_VERSION),
    writeStringField(3, apiKey),
    writeStringField(4, 'en'),
    writeStringField(5, _os),
    writeStringField(7, DEFAULT_CLIENT_VERSION),
    writeStringField(8, _hw),
    writeVarintField(9, Math.floor(Math.random() * 2 ** 48)),
    writeStringField(10, sessionId || randomUUID()),
    writeStringField(12, 'windsurf'),
  ]);
}

// ─── ChatMessage ───────────────────────────────────────────
function buildChatMessage(content: string, source: number, conversationId: string): Buffer {
  const parts: Buffer[] = [
    writeStringField(1, randomUUID()),
    writeVarintField(2, source),
    writeMessageField(3, encodeTimestamp()),
    writeStringField(4, conversationId),
  ];
  if (source === SOURCE.ASSISTANT) {
    const actionGeneric = writeStringField(1, content);
    const action = writeMessageField(1, actionGeneric);
    parts.push(writeMessageField(6, action));
  } else {
    const intentGeneric = writeStringField(1, content);
    const intent = writeMessageField(1, intentGeneric);
    parts.push(writeMessageField(5, intent));
  }
  return Buffer.concat(parts);
}

// ─── RawGetChatMessageRequest builder ─────────────────────
export interface WindsurfMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{ function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

export interface WindsurfGrpcRequest {
  apiKey: string;
  messages: WindsurfMessage[];
  modelEnum: number;
  modelName?: string;
  sessionId?: string;
}

export function buildRawGetChatMessageRequest(req: WindsurfGrpcRequest): Buffer {
  const { apiKey, messages, modelEnum, modelName, sessionId } = req;
  const parts: Buffer[] = [];
  const conversationId = randomUUID();

  parts.push(writeMessageField(1, buildMetadata(apiKey, sessionId ?? null)));

  let systemPrompt = '';
  for (const msg of messages) {
    if (msg.role === 'system') {
      systemPrompt += (systemPrompt ? '\n' : '') + msg.content;
      continue;
    }
    let source: number;
    let text: string;
    if (msg.role === 'user') { source = SOURCE.USER; text = msg.content; }
    else if (msg.role === 'assistant') {
      source = SOURCE.ASSISTANT;
      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
        const tcLines = msg.tool_calls.map((tc) =>
          `[called tool ${tc.function?.name || 'unknown'} with ${tc.function?.arguments || '{}'}]`
        ).join('\n');
        text = msg.content ? `${msg.content}\n${tcLines}` : tcLines;
      } else { text = msg.content; }
    } else if (msg.role === 'tool') {
      source = SOURCE.USER;
      text = `[tool result${msg.tool_call_id ? ` for ${msg.tool_call_id}` : ''}]: ${msg.content}`;
    } else { source = SOURCE.USER; text = msg.content; }
    parts.push(writeMessageField(2, buildChatMessage(text, source, conversationId)));
  }

  if (systemPrompt) parts.push(writeStringField(3, systemPrompt));
  parts.push(writeVarintField(4, modelEnum));
  if (modelName) parts.push(writeStringField(5, modelName));

  return Buffer.concat(parts);
}

// ─── RawGetChatMessageResponse parser ─────────────────────
export interface ParsedRawChunk {
  text: string;
  inProgress: boolean;
  isError: boolean;
}

export function parseRawResponse(buf: Buffer): ParsedRawChunk {
  const fields = parseFields(buf);
  const f1 = getField(fields, 1, 2); // delta_message
  if (!f1) return { text: '', inProgress: false, isError: false };
  const inner = parseFields(f1.value as Buffer);
  const text = getField(inner, 5, 2);
  const inProgress = getField(inner, 6, 0);
  const isError = getField(inner, 7, 0);
  return {
    text: text ? (text.value as Buffer).toString('utf8') : '',
    inProgress: inProgress ? Boolean(inProgress.value) : false,
    isError: isError ? Boolean(isError.value) : false,
  };
}

// ─── GrpcBridge ────────────────────────────────────────────
export interface GrpcBridgeOptions {
  lsPort: number;
  csrfToken: string;
  modelEnum: number;
  modelName?: string;
  sessionId?: string;
  onChunk: (text: string, done: boolean) => void;
  onError: (err: Error) => void;
}

export function startGrpcStream(
  apiKey: string,
  messages: WindsurfMessage[],
  opts: GrpcBridgeOptions,
): void {
  const { lsPort, csrfToken, modelEnum, modelName, sessionId, onChunk, onError } = opts;
  const req = buildRawGetChatMessageRequest({ apiKey, messages, modelEnum, modelName, sessionId });
  const body = grpcFrame(req);

  grpcStream(lsPort, csrfToken, `${LS_SERVICE}/RawGetChatMessage`, body, {
    onData: (payload) => {
      const parsed = parseRawResponse(payload);
      if (parsed.text) {
        const errMatch = /^(permission_denied|failed_precondition|not_found|unauthenticated):/.test(parsed.text.trim());
        if (parsed.isError || errMatch) {
          const err = new Error(parsed.text.trim()) as Error & { isModelError?: boolean };
          err.isModelError = /permission_denied|failed_precondition/.test(parsed.text);
          onError(err);
          return;
        }
        onChunk(parsed.text, parsed.inProgress);
      }
    },
    onEnd: () => { onChunk('', true); },
    onError,
  });
}
