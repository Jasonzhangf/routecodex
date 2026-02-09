import type { HttpProtocolClient, ProtocolRequestPayload } from '../http-protocol-client.js';
import { stripInternalKeysDeep } from '../../utils/strip-internal-keys.js';

interface DataEnvelope {
  data?: Record<string, unknown>;
}

interface OpenAIChatMessage {
  role?: unknown;
  content?: unknown;
}

interface GeminiPayload extends Record<string, unknown> {
  model?: string;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  messages?: unknown;
  contents?: unknown;
  systemInstruction?: unknown;
  generationConfig?: Record<string, unknown>;
}

function hasDataEnvelope(payload: ProtocolRequestPayload): payload is ProtocolRequestPayload & DataEnvelope {
  return typeof payload === 'object' && payload !== null && 'data' in payload;
}

function isOpenAiChatMessage(value: unknown): value is OpenAIChatMessage {
  return !!value && typeof value === 'object' && 'role' in (value as Record<string, unknown>);
}

function normalizeMessageText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  try {
    return JSON.stringify(content ?? '');
  } catch {
    return String(content ?? '');
  }
}

function hasGeminiShape(payload: GeminiPayload): boolean {
  return Array.isArray(payload.contents) || (!!payload.systemInstruction && typeof payload.systemInstruction === 'object');
}

function convertOpenAiMessagesToGeminiPayload(payload: GeminiPayload): GeminiPayload {
  if (hasGeminiShape(payload)) {
    return payload;
  }

  const messages = Array.isArray(payload.messages) ? payload.messages.filter(isOpenAiChatMessage) : [];
  if (!messages.length) {
    return payload;
  }

  const systemMessages = messages.filter((item) => item.role === 'system' && typeof item.content === 'string');
  const userAndAssistant = messages.filter((item) => item.role === 'user' || item.role === 'assistant');

  const contents = userAndAssistant.map((message) => ({
    role: message.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: normalizeMessageText(message.content) }]
  }));

  const systemInstruction =
    systemMessages.length > 0
      ? {
          role: 'system',
          parts: [{ text: systemMessages.map((item) => String(item.content)).join('\n') }]
        }
      : undefined;

  const rebuilt: GeminiPayload = {
    ...payload,
    contents,
    ...(systemInstruction ? { systemInstruction } : {})
  };

  delete rebuilt.messages;
  delete (rebuilt as Record<string, unknown>).stream;
  return rebuilt;
}

export class GeminiProtocolClient implements HttpProtocolClient<ProtocolRequestPayload> {
  buildRequestBody(request: ProtocolRequestPayload): Record<string, unknown> {
    const payload = this.extractPayload(request);
    const normalizedPayload = convertOpenAiMessagesToGeminiPayload(payload);
    const body: GeminiPayload = { ...normalizedPayload };

    const model = typeof body.model === 'string' ? body.model.trim() : '';
    if (!model) {
      throw new Error('provider-runtime-error: missing model from virtual router');
    }

    if ('metadata' in body) {
      delete (body as unknown as { metadata?: unknown }).metadata;
    }

    const generationConfig = this.extractGenerationConfig(body);
    delete body.model;
    if ('max_tokens' in body) {
      delete body.max_tokens;
    }
    if (generationConfig) {
      body.generationConfig = generationConfig;
    }
    return stripInternalKeysDeep(body);
  }

  resolveEndpoint(request: ProtocolRequestPayload, defaultEndpoint: string): string {
    const payload = this.extractPayload(request);
    const model = typeof payload.model === 'string' ? payload.model.trim() : '';
    if (!model) {
      return defaultEndpoint;
    }
    return `/models/${encodeURIComponent(model)}:generateContent`;
  }

  finalizeHeaders(
    headers: Record<string, string>,
    _request: ProtocolRequestPayload
  ): Record<string, string> {
    const normalized: Record<string, string> = { ...headers };
    const hasGeminiKey = Object.keys(normalized).some((key) => key.toLowerCase() === 'x-goog-api-key');
    if (!hasGeminiKey) {
      const authorizationKey = Object.keys(normalized).find((key) => key.toLowerCase() === 'authorization');
      if (authorizationKey) {
        const token = normalized[authorizationKey]?.replace(/^Bearer\s+/i, '').trim();
        if (token) {
          normalized['x-goog-api-key'] = token;
          delete normalized[authorizationKey];
        }
      }
    }
    if (!('Accept' in normalized) && !('accept' in normalized)) {
      normalized['Accept'] = 'application/json';
    }
    return normalized;
  }

  private extractPayload(request: ProtocolRequestPayload): GeminiPayload {
    if (hasDataEnvelope(request)) {
      const envelopeData = request.data;
      if (envelopeData && typeof envelopeData === 'object') {
        return envelopeData as GeminiPayload;
      }
    }
    return { ...(request as Record<string, unknown>) } as GeminiPayload;
  }

  private extractGenerationConfig(payload: GeminiPayload): Record<string, unknown> | undefined {
    const generationConfig =
      typeof payload.generationConfig === 'object' && payload.generationConfig !== null
        ? { ...(payload.generationConfig as Record<string, unknown>) }
        : {};

    if (typeof payload.max_tokens === 'number') {
      generationConfig.maxOutputTokens = payload.max_tokens;
    }
    if (typeof payload.temperature === 'number') {
      generationConfig.temperature = payload.temperature;
    }
    if (typeof payload.top_p === 'number') {
      generationConfig.topP = payload.top_p;
    }

    return Object.keys(generationConfig).length > 0 ? generationConfig : undefined;
  }
}
