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
  writeVarintField, writeStringField, writeMessageField, writeBoolField, getAllFields,
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

export function buildInitializePanelStateRequest(apiKey: string, sessionId: string, trusted = true): Buffer {
  return Buffer.concat([
    writeMessageField(1, buildMetadata(apiKey, sessionId)),
    writeBoolField(3, trusted),
  ]);
}

export function buildHeartbeatRequest(apiKey: string, sessionId: string): Buffer {
  return writeMessageField(1, buildMetadata(apiKey, sessionId));
}

export function buildAddTrackedWorkspaceRequest(workspacePath: string): Buffer {
  return writeStringField(1, workspacePath);
}

export function buildUpdateWorkspaceTrustRequest(
  apiKey: string,
  _ignoredWorkspaceUri: string | undefined,
  trusted: boolean,
  sessionId: string,
): Buffer {
  return Buffer.concat([
    writeMessageField(1, buildMetadata(apiKey, sessionId)),
    writeBoolField(2, trusted),
  ]);
}

export function buildUpdatePanelStateWithUserStatusRequest(
  apiKey: string,
  sessionId: string,
  userStatusBytes: Buffer | null,
): Buffer {
  const parts: Buffer[] = [writeMessageField(1, buildMetadata(apiKey, sessionId))];
  if (userStatusBytes && userStatusBytes.length > 0) {
    parts.push(writeMessageField(2, userStatusBytes));
  }
  return Buffer.concat(parts);
}

export function buildStartCascadeRequest(apiKey: string, sessionId: string): Buffer {
  return Buffer.concat([
    writeMessageField(1, buildMetadata(apiKey, sessionId)),
    writeVarintField(4, 1),
    writeVarintField(5, 1),
  ]);
}

function buildCascadeConfig(
  modelEnum: number,
  modelUid?: string,
  options?: { toolPreamble?: string }
): Buffer {
  const toolPreamble = options?.toolPreamble?.trim() || '';

  const convParts: Buffer[] = [writeVarintField(4, 3)];

  if (toolPreamble) {
    const additionalSection = Buffer.concat([
      writeVarintField(1, 1),
      writeStringField(2, toolPreamble),
    ]);
    convParts.push(writeMessageField(12, additionalSection));

    const communicationOverride = Buffer.concat([
      writeVarintField(1, 1),
      writeStringField(2, 'Use the provided tool definitions when appropriate.'),
    ]);
    convParts.push(writeMessageField(13, communicationOverride));
  } else {
    const noToolSection = Buffer.concat([
      writeVarintField(1, 1),
      writeStringField(2, 'No tools are available.'),
    ]);
    convParts.push(writeMessageField(10, noToolSection));

    const noToolAdditional = Buffer.concat([
      writeVarintField(1, 1),
      writeStringField(2, 'You are being accessed as a plain chat API. You have no tools, no file access, and no shell access. Answer directly from the provided conversation only.'),
    ]);
    convParts.push(writeMessageField(12, noToolAdditional));

    const communicationOverride = Buffer.concat([
      writeVarintField(1, 1),
      writeStringField(2, 'Respond directly and do not narrate tool usage.'),
    ]);
    convParts.push(writeMessageField(13, communicationOverride));
  }

  const conversationalConfig = Buffer.concat(convParts);
  const plannerParts: Buffer[] = [
    writeMessageField(2, conversationalConfig),
  ];

  if (modelUid) {
    plannerParts.push(writeStringField(35, modelUid));
    plannerParts.push(writeStringField(34, modelUid));
  }
  if (modelEnum && modelEnum > 0) {
    plannerParts.push(writeMessageField(15, writeVarintField(1, modelEnum)));
    plannerParts.push(writeVarintField(1, modelEnum));
  }
  if (!modelUid && !modelEnum) {
    throw new Error('buildCascadeConfig: at least one of modelUid or modelEnum must be provided');
  }

  plannerParts.push(writeVarintField(6, 32768));

  if (!toolPreamble) {
    const emptySection = Buffer.concat([
      writeVarintField(1, 1),
      writeStringField(2, ''),
    ]);
    plannerParts.push(writeMessageField(11, emptySection));
  }

  const plannerConfig = Buffer.concat(plannerParts);
  const brainConfig = Buffer.concat([
    writeVarintField(1, 1),
    writeMessageField(6, writeMessageField(6, Buffer.alloc(0))),
  ]);
  const memoryConfig = Buffer.concat([writeBoolField(1, false)]);

  return Buffer.concat([
    writeMessageField(1, plannerConfig),
    writeMessageField(5, memoryConfig),
    writeMessageField(7, brainConfig),
  ]);
}

export function buildSendCascadeMessageRequest(
  apiKey: string,
  cascadeId: string,
  text: string,
  modelEnum: number,
  modelUid: string | undefined,
  sessionId: string,
  options?: { toolPreamble?: string }
): Buffer {
  return Buffer.concat([
    writeStringField(1, cascadeId),
    writeMessageField(2, writeStringField(1, text)),
    writeMessageField(3, buildMetadata(apiKey, sessionId)),
    writeMessageField(5, buildCascadeConfig(modelEnum, modelUid, options)),
  ]);
}

export function buildGetTrajectoryStepsRequest(cascadeId: string, stepOffset = 0): Buffer {
  const parts = [writeStringField(1, cascadeId)];
  if (stepOffset > 0) {
    parts.push(writeVarintField(2, stepOffset));
  }
  return Buffer.concat(parts);
}

export function buildGetTrajectoryRequest(cascadeId: string): Buffer {
  return writeStringField(1, cascadeId);
}

export function buildGetGeneratorMetadataRequest(cascadeId: string, offset = 0): Buffer {
  const parts = [writeStringField(1, cascadeId)];
  if (offset > 0) {
    parts.push(writeVarintField(2, offset));
  }
  return Buffer.concat(parts);
}

export function parseStartCascadeResponse(buf: Buffer): string {
  const fields = parseFields(buf);
  const field = getField(fields, 1, 2);
  return field ? (field.value as Buffer).toString('utf8') : '';
}

export function parseTrajectoryStatus(buf: Buffer): number {
  const fields = parseFields(buf);
  const field = getField(fields, 2, 0);
  return field ? Number(field.value) : 0;
}

export interface ParsedTrajectoryStep {
  type: number;
  status: number;
  text: string;
  responseText: string;
  modifiedText: string;
  thinking: string;
  errorText: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  } | null;
}

export function parseTrajectorySteps(buf: Buffer): ParsedTrajectoryStep[] {
  const fields = parseFields(buf);
  const steps = getAllFields(fields, 1).filter((field) => field.wireType === 2);
  const out: ParsedTrajectoryStep[] = [];
  for (const step of steps) {
    const stepFields = parseFields(step.value as Buffer);
    const typeField = getField(stepFields, 1, 0);
    const statusField = getField(stepFields, 4, 0);
    const plannerField = getField(stepFields, 20, 2);
    let text = '';
    let responseText = '';
    let modifiedText = '';
    let thinking = '';
    let errorText = '';
    const readErrorDetails = (errorBuf: Buffer): string => {
      const errorFields = parseFields(errorBuf);
      for (const fieldNum of [1, 2, 3]) {
        const field = getField(errorFields, fieldNum, 2);
        if (field) {
          const value = (field.value as Buffer).toString('utf8').trim();
          if (value) {
            return value.split('\n')[0].slice(0, 300);
          }
        }
      }
      return '';
    };
    if (plannerField) {
      const plannerFields = parseFields(plannerField.value as Buffer);
      responseText = (getField(plannerFields, 1, 2)?.value as Buffer | undefined)?.toString('utf8') || '';
      modifiedText = (getField(plannerFields, 8, 2)?.value as Buffer | undefined)?.toString('utf8') || '';
      text = modifiedText || responseText;
      thinking = (getField(plannerFields, 3, 2)?.value as Buffer | undefined)?.toString('utf8') || '';
    }
    const errorMessageField = getField(stepFields, 24, 2);
    if (errorMessageField) {
      const wrappedFields = parseFields(errorMessageField.value as Buffer);
      const innerField = getField(wrappedFields, 3, 2);
      if (innerField) {
        errorText = readErrorDetails(innerField.value as Buffer);
      }
    }
    if (!errorText) {
      const errorField = getField(stepFields, 31, 2);
      if (errorField) {
        errorText = readErrorDetails(errorField.value as Buffer);
      }
    }
    let usage: ParsedTrajectoryStep['usage'] = null;
    const stepMetaField = getField(stepFields, 5, 2);
    if (stepMetaField) {
      const metaFields = parseFields(stepMetaField.value as Buffer);
      const usageField = getField(metaFields, 9, 2);
      if (usageField) {
        const usageFields = parseFields(usageField.value as Buffer);
        const readUint = (fieldNum: number): number => {
          const field = getField(usageFields, fieldNum, 0);
          return field ? Number(field.value) : 0;
        };
        const inputTokens = readUint(2);
        const outputTokens = readUint(3);
        const cacheWriteTokens = readUint(4);
        const cacheReadTokens = readUint(5);
        if (inputTokens || outputTokens || cacheWriteTokens || cacheReadTokens) {
          usage = { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
        }
      }
    }
    out.push({
      type: typeField ? Number(typeField.value) : 0,
      status: statusField ? Number(statusField.value) : 0,
      text,
      responseText,
      modifiedText,
      thinking,
      errorText,
      usage,
    });
  }
  return out;
}

export function buildGetUserStatusRequest(apiKey: string): Buffer {
  return writeMessageField(1, buildMetadata(apiKey));
}

export function extractUserStatusBytes(getUserStatusResponseBuf: Buffer): Buffer | null {
  if (!getUserStatusResponseBuf || getUserStatusResponseBuf.length === 0) {
    return null;
  }
  const top = parseFields(getUserStatusResponseBuf);
  const field = getField(top, 1, 2);
  return field ? (field.value as Buffer) : null;
}

export function parseGeneratorMetadata(buf: Buffer): {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  entryCount: number;
} | null {
  const fields = parseFields(buf);
  const entries = getAllFields(fields, 1).filter((field) => field.wireType === 2);
  if (entries.length === 0) {
    return null;
  }
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let found = false;
  for (const entry of entries) {
    const generatorFields = parseFields(entry.value as Buffer);
    const chatModelField = getField(generatorFields, 1, 2);
    if (!chatModelField) {
      continue;
    }
    const chatModelFields = parseFields(chatModelField.value as Buffer);
    const usageField = getField(chatModelFields, 4, 2);
    if (!usageField) {
      continue;
    }
    const usageFields = parseFields(usageField.value as Buffer);
    const readUint = (fieldNum: number): number => {
      const field = getField(usageFields, fieldNum, 0);
      return field ? Number(field.value) : 0;
    };
    const input = readUint(2);
    const output = readUint(3);
    const cacheWrite = readUint(4);
    const cacheRead = readUint(5);
    if (input || output || cacheWrite || cacheRead) {
      found = true;
      inputTokens += input;
      outputTokens += output;
      cacheWriteTokens += cacheWrite;
      cacheReadTokens += cacheRead;
    }
  }
  if (!found) {
    return null;
  }
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    entryCount: entries.length,
  };
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
