import type { ConversionCodec, ConversionContext, ConversionProfile } from '../types.js';
import type { JsonObject, JsonValue } from '../hub/types/json.js';
import { ProviderProtocolError } from '../provider-protocol-error.js';
import {
  runGeminiFromOpenAIChatCodecWithNative,
  runGeminiOpenAIRequestCodecWithNative,
  runGeminiOpenAIResponseCodecWithNative
} from '../../router/virtual-router/engine-selection/native-compat-action-semantics.js';
import { buildChatResponseFromResponsesWithNative } from '../../router/virtual-router/engine-selection/native-shared-conversion-semantics.js';
import {
  consumeResponsesPassthroughByAliases,
  consumeResponsesPayloadSnapshotByAliases,
  registerResponsesPassthrough,
  registerResponsesPayloadSnapshot
} from '../shared/responses-reasoning-registry.js';

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every((entry) => isJsonValue(entry));
  }
  if (!value || typeof value !== 'object') {
    return false;
  }
  return Object.values(value as Record<string, unknown>).every((entry) => isJsonValue(entry));
}

function narrowJsonObject(value: Record<string, unknown>): JsonObject {
  const out: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isJsonValue(entry)) {
      out[key] = entry;
    }
  }
  return out;
}

function cloneJsonRecord(value: Record<string, unknown>): Record<string, unknown> | undefined {
  try {
    const structuredCloneImpl = (globalThis as { structuredClone?: <T>(input: T) => T }).structuredClone;
    if (typeof structuredCloneImpl === 'function') {
      return structuredCloneImpl(value);
    }
  } catch {
    /* ignore structuredClone failures */
  }
  try {
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  } catch {
    return { ...value };
  }
}

function stripInternalContinuationRequestId(chat: Record<string, unknown>): void {
  const semantics =
    chat?.semantics && typeof chat.semantics === 'object' && !Array.isArray(chat.semantics)
      ? (chat.semantics as Record<string, unknown>)
      : undefined;
  const continuation =
    semantics?.continuation && typeof semantics.continuation === 'object' && !Array.isArray(semantics.continuation)
      ? (semantics.continuation as Record<string, unknown>)
      : undefined;
  const resumeFrom =
    continuation?.resumeFrom && typeof continuation.resumeFrom === 'object' && !Array.isArray(continuation.resumeFrom)
      ? (continuation.resumeFrom as Record<string, unknown>)
      : undefined;
  if (resumeFrom && typeof resumeFrom.requestId === 'string') {
    delete resumeFrom.requestId;
  }
}

function restoreResponsesSemanticsFromSnapshot(
  chatResponse: JsonObject,
  payloadSnapshot: Record<string, unknown> | undefined
): void {
  if (!payloadSnapshot || typeof payloadSnapshot !== 'object' || Array.isArray(payloadSnapshot)) {
    return;
  }
  const restored = buildChatResponseFromResponsesWithNative(payloadSnapshot);
  if (!restored || typeof restored !== 'object' || Array.isArray(restored)) {
    return;
  }
  stripInternalContinuationRequestId(restored);
  const semantics =
    restored.semantics && typeof restored.semantics === 'object' && !Array.isArray(restored.semantics)
      ? cloneJsonRecord(restored.semantics as Record<string, unknown>)
      : undefined;
  if (semantics) {
    (chatResponse as any).semantics = semantics;
  }
}

function registerRetentionPayloads(
  ids: Array<unknown>,
  payloadSnapshot: Record<string, unknown> | undefined,
  passthroughPayload: Record<string, unknown> | undefined
): void {
  const aliases = new Set(
    ids.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
  );
  for (const candidate of aliases) {
    if (payloadSnapshot) {
      registerResponsesPayloadSnapshot(candidate, payloadSnapshot, { clone: false });
    }
    if (passthroughPayload) {
      registerResponsesPassthrough(candidate, passthroughPayload, { clone: false });
    }
  }
}

function unwrapProviderProtocolError(result: Record<string, unknown>): never | void {
  const raw = result.__providerProtocolError;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return;
  }
  const error = raw as Record<string, unknown>;
  throw new ProviderProtocolError(String(error.message ?? 'Gemini provider protocol error'), {
    code: String(error.code ?? 'MALFORMED_RESPONSE') as any,
    protocol: typeof error.protocol === 'string' ? error.protocol : 'gemini-chat',
    providerType: typeof error.providerType === 'string' ? error.providerType : 'gemini',
    category:
      error.category === 'TOOL_ERROR' || error.category === 'INTERNAL_ERROR' || error.category === 'EXTERNAL_ERROR'
        ? error.category
        : undefined,
    details:
      error.details && typeof error.details === 'object' && !Array.isArray(error.details)
        ? (error.details as Record<string, unknown>)
        : undefined
  });
}

export function buildOpenAIChatFromGeminiRequest(payload: unknown): { messages: JsonValue[] } & JsonObject {
  const native = runGeminiOpenAIRequestCodecWithNative((payload ?? {}) as Record<string, unknown>);
  const request = narrowJsonObject(native);
  return {
    ...request,
    messages: Array.isArray(native.messages) ? native.messages.filter((entry): entry is JsonValue => isJsonValue(entry)) : []
  };
}

export function buildOpenAIChatFromGeminiResponse(payload: unknown): JsonObject {
  const result = runGeminiOpenAIResponseCodecWithNative((payload ?? {}) as Record<string, unknown>);
  unwrapProviderProtocolError(result);
  const chatResponse = narrowJsonObject(result);
  const retentionAliases = [
    (chatResponse as any).id,
    (chatResponse as any).request_id,
    (payload as any)?.id,
    (payload as any)?.request_id,
    (result as any)?.id,
    (result as any)?.request_id
  ];
  const payloadSnapshot = consumeResponsesPayloadSnapshotByAliases(retentionAliases);
  if (payloadSnapshot) {
    registerResponsesPayloadSnapshot((chatResponse as any).id, payloadSnapshot, { clone: false });
    (chatResponse as any).__responses_payload_snapshot = payloadSnapshot;
    if (typeof (chatResponse as any).request_id !== 'string') {
      (chatResponse as any).request_id = (chatResponse as any).id;
    }
    restoreResponsesSemanticsFromSnapshot(chatResponse, payloadSnapshot);
  }
  const passthroughPayload = consumeResponsesPassthroughByAliases(retentionAliases);
  if (passthroughPayload) {
    registerResponsesPassthrough((chatResponse as any).id, passthroughPayload, { clone: false });
    (chatResponse as any).__responses_passthrough = passthroughPayload;
    if (typeof (chatResponse as any).request_id !== 'string') {
      (chatResponse as any).request_id = (chatResponse as any).id;
    }
  }
  return chatResponse;
}

export function buildGeminiFromOpenAIChat(chatResp: unknown): JsonObject {
  const result = runGeminiFromOpenAIChatCodecWithNative((chatResp ?? {}) as Record<string, unknown>);
  const payload = narrowJsonObject(result);
  const retainedSnapshot =
    (chatResp as any)?.__responses_payload_snapshot &&
    typeof (chatResp as any).__responses_payload_snapshot === 'object' &&
    !Array.isArray((chatResp as any).__responses_payload_snapshot)
      ? ((chatResp as any).__responses_payload_snapshot as Record<string, unknown>)
      : undefined;
  const retainedPassthrough =
    (chatResp as any)?.__responses_passthrough &&
    typeof (chatResp as any).__responses_passthrough === 'object' &&
    !Array.isArray((chatResp as any).__responses_passthrough)
      ? ((chatResp as any).__responses_passthrough as Record<string, unknown>)
      : undefined;
  registerRetentionPayloads(
    [payload.id, (payload as any).request_id, (chatResp as any)?.id, (chatResp as any)?.request_id],
    retainedSnapshot,
    retainedPassthrough
  );
  return payload;
}

export class GeminiOpenAIConversionCodec implements ConversionCodec {
  readonly id = 'gemini-openai';
  private initialized = false;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(private readonly _dependencies: any) {}

  async initialize(): Promise<void> {
    this.initialized = true;
  }

  private async ensureInit(): Promise<void> {
    if (!this.initialized) await this.initialize();
  }

  async convertRequest(payload: any, _profile: ConversionProfile, _context: ConversionContext): Promise<any> {
    await this.ensureInit();
    return buildOpenAIChatFromGeminiRequest(payload);
  }

  async convertResponse(payload: any, _profile: ConversionProfile, _context: ConversionContext): Promise<any> {
    await this.ensureInit();
    return buildGeminiFromOpenAIChat(payload);
  }
}
