import type { ConversionCodec, ConversionContext, ConversionProfile } from '../types.js';
import type { JsonObject, JsonValue } from '../hub/types/json.js';
import { ProviderProtocolError } from '../provider-protocol-error.js';
import {
  runGeminiFromOpenAIChatCodecWithNative,
  runGeminiOpenAIRequestCodecWithNative,
  runGeminiOpenAIResponseCodecWithNative
} from '../../router/virtual-router/engine-selection/native-compat-action-semantics.js';

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
  return narrowJsonObject(result);
}

export function buildGeminiFromOpenAIChat(chatResp: unknown): JsonObject {
  const result = runGeminiFromOpenAIChatCodecWithNative((chatResp ?? {}) as Record<string, unknown>);
  return narrowJsonObject(result);
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
