/**
 * Gemini HTTP Provider (V2)
 *
 * 以 Gemini Chat 协议（gemini-chat）为目标，调用 Google Generative Language API。
 * - 默认基地址：https://generativelanguage.googleapis.com/v1beta
 * - 生成路径：/models/{model}:generateContent
 * - 认证：优先使用 header 'x-goog-api-key: <API_KEY>'；若仅提供 Authorization: Bearer <key>，自动转换为 x-goog-api-key。
 * - 形状转换：在 preprocessRequest 做最小映射（OpenAI Chat → Gemini contents）；若已经是 Gemini 形状（contents/systemInstruction）则透传。
 */

import { HttpTransportProvider } from './http-transport-provider.js';
import type { OpenAIStandardConfig } from '../api/provider-config.js';
import type { ProviderContext, ServiceProfile, ProviderType } from '../api/provider-types.js';
import type { UnknownObject } from '../../../types/common-types.js';
import type { ModuleDependencies } from '../../../modules/pipeline/interfaces/pipeline-interfaces.js';
import { GeminiProtocolClient } from '../../../client/gemini/gemini-protocol-client.js';

type DataEnvelope = UnknownObject & { data?: UnknownObject };

type OpenAIChatMessage = {
  role?: string;
  content?: unknown;
};

type MutablePayload = Record<string, unknown> & {
  messages?: unknown;
  stream?: unknown;
  model?: unknown;
  generationConfig?: Record<string, unknown>;
};

export class GeminiHttpProvider extends HttpTransportProvider {
  constructor(config: OpenAIStandardConfig, dependencies: ModuleDependencies) {
    const cfg: OpenAIStandardConfig = {
      ...config,
      config: {
        ...config.config,
        providerType: 'gemini' as ProviderType
      }
    };
    super(cfg, dependencies, 'gemini-http-provider', new GeminiProtocolClient());
  }

  protected getServiceProfile(): ServiceProfile {
    return {
      defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      defaultEndpoint: '/models:generateContent', // 实际发送时注入 /{model}:generateContent
      defaultModel: '',
      requiredAuth: ['apikey'],
      optionalAuth: [],
      headers: { 'Content-Type': 'application/json' },
      timeout: 300000,
      maxRetries: 2
    };
  }

  protected override async preprocessRequest(request: UnknownObject): Promise<UnknownObject> {
    const adapter = this.resolvePayload(request);
    const payload = adapter.payload;

    if (this.isGeminiPayload(payload)) {
      return request;
    }

    const messages = Array.isArray(payload.messages) ? payload.messages.filter(this.isChatMessage) : [];
    const systemMsgs = messages.filter((m) => m.role === 'system' && typeof m.content === 'string');
    const userOrAssistant = messages.filter((m) => m.role === 'user' || m.role === 'assistant');
    const contents = userOrAssistant.map((message) => ({
      role: message.role === 'assistant' ? 'model' as const : 'user' as const,
      parts: [{ text: this.normalizeMessageText(message.content) }]
    }));
    const systemInstruction = systemMsgs.length > 0
      ? { role: 'system', parts: [{ text: systemMsgs.map((msg) => String(msg.content)).join('\n') }] }
      : undefined;

    const generationConfig = this.buildGenerationConfig(payload);

    const rebuilt: MutablePayload = {
      ...payload,
      contents,
      ...(systemInstruction ? { systemInstruction } : {}),
      ...(generationConfig ? { generationConfig } : {})
    };

    delete rebuilt.messages;
    delete rebuilt.stream;

    return adapter.assign(rebuilt);
  }

  protected override async postprocessResponse(response: unknown, _context: ProviderContext): Promise<UnknownObject> {
    if (response && typeof response === 'object') {
      return response as UnknownObject;
    }
    return { data: response } as UnknownObject;
  }

  private resolvePayload(source: UnknownObject): {
    payload: MutablePayload;
    assign(updated: MutablePayload): UnknownObject;
  } {
    if (this.hasDataEnvelope(source)) {
      const envelope = source as DataEnvelope;
      const dataRecord = (envelope.data && typeof envelope.data === 'object')
        ? envelope.data as MutablePayload
        : {};
      if (!envelope.data || typeof envelope.data !== 'object') {
        envelope.data = dataRecord;
      }
      return {
        payload: dataRecord,
        assign: (updated) => {
          envelope.data = updated;
          return source;
        }
      };
    }
    return {
      payload: source as MutablePayload,
      assign: (updated) => updated
    };
  }

  private isGeminiPayload(payload: Record<string, unknown>): boolean {
    const hasContents = Array.isArray(payload.contents);
    const hasSystemInstruction = typeof payload.systemInstruction === 'object' && payload.systemInstruction !== null;
    return hasContents || hasSystemInstruction;
  }

  private isChatMessage(message: unknown): message is OpenAIChatMessage {
    return Boolean(
      message &&
      typeof message === 'object' &&
      ('role' in (message as Record<string, unknown>))
    );
  }

  private normalizeMessageText(content: unknown): string {
    if (typeof content === 'string') {
      return content;
    }
    return JSON.stringify(content ?? '');
  }

  private buildGenerationConfig(payload: Record<string, unknown>): Record<string, unknown> | undefined {
    const generationConfig = typeof payload.generationConfig === 'object' && payload.generationConfig !== null
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

export default GeminiHttpProvider;
