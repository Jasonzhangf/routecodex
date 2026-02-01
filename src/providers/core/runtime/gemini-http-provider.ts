/**
 * Gemini HTTP Provider (V2)
 *
 * 以 Gemini Chat 协议（gemini-chat）为目标，调用 Google Generative Language API。
 * - 默认基地址：https://generativelanguage.googleapis.com/v1beta
 * - 生成路径：/models/{model}:generateContent
 * - 认证：优先使用 header 'x-goog-api-key: <API_KEY>'；若仅提供 Authorization: Bearer <key>，自动转换为 x-goog-api-key。
 * - 形状转换：在 preprocessRequest 做最小映射（OpenAI Chat → Gemini contents）；若已经是 Gemini 形状（contents/systemInstruction）则透传。
 */

import { randomUUID } from 'node:crypto';
import { HttpTransportProvider } from './http-transport-provider.js';
import type { OpenAIStandardConfig } from '../api/provider-config.js';
import type { ProviderContext, ProviderType } from '../api/provider-types.js';
import type { UnknownObject } from '../../../types/common-types.js';
import type { ModuleDependencies } from '../../../modules/pipeline/interfaces/pipeline-interfaces.js';
import {
  extractAntigravityGeminiSessionId,
  lookupAntigravitySessionSignatureEntry
} from '../../../modules/llmswitch/bridge.js';
import { GeminiProtocolClient } from '../../../client/gemini/gemini-protocol-client.js';
import { resolveAntigravityUserAgent } from '../../auth/antigravity-user-agent.js';

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

  protected override async preprocessRequest(request: UnknownObject): Promise<UnknownObject> {
    const processedRequest = await super.preprocessRequest(request);
    const adapter = this.resolvePayload(processedRequest);
    const payload = adapter.payload;

    if (this.isGeminiPayload(payload)) {
      if (this.isAntigravityRuntime()) {
        this.applyAntigravityRequestCompat(processedRequest);
      }
      return processedRequest;
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

    const next = adapter.assign(rebuilt);
    if (this.isAntigravityRuntime()) {
      this.applyAntigravityRequestCompat(next);
    }
    return next;
  }

  protected override applyStreamModeHeaders(headers: Record<string, string>, wantsSse: boolean): Record<string, string> {
    if (!this.isAntigravityRuntime()) {
      return super.applyStreamModeHeaders(headers, wantsSse);
    }
    if (this.getAntigravityHeaderMode() === 'minimal') {
      return { ...headers, Accept: '*/*' };
    }
    return super.applyStreamModeHeaders(headers, wantsSse);
  }

  protected override async finalizeRequestHeaders(
    headers: Record<string, string>,
    request: UnknownObject
  ): Promise<Record<string, string>> {
    const finalized = await super.finalizeRequestHeaders(headers, request);
    if (!this.isAntigravityRuntime()) {
      return finalized;
    }

    const headerMode = this.getAntigravityHeaderMode();
    const deleteHeaderInsensitive = (key: string): void => {
      const target = key.toLowerCase();
      for (const k of Object.keys(finalized)) {
        if (k.toLowerCase() === target) {
          delete finalized[k];
        }
      }
    };

    const alias = this.extractAntigravityAliasFromRuntime();
    finalized['User-Agent'] = await resolveAntigravityUserAgent({ alias });

    // Antigravity-Manager alignment: keep headers minimal (no Google client identifiers).
    deleteHeaderInsensitive('x-goog-api-client');
    deleteHeaderInsensitive('client-metadata');
    deleteHeaderInsensitive('accept-encoding');
    deleteHeaderInsensitive('originator');

    if (headerMode === 'minimal') {
      const record = request as Record<string, unknown>;
      const reqId = typeof record.requestId === 'string' ? record.requestId : undefined;
      if (reqId && reqId.trim()) {
        (finalized as any).requestId = reqId;
      }
      const hasImageAttachment =
        (request as any)?.metadata &&
        (((request as any).metadata as Record<string, unknown>).hasImageAttachment === true ||
          ((request as any).metadata as Record<string, unknown>).hasImageAttachment === 'true');
      (finalized as any).requestType = hasImageAttachment ? 'image_gen' : 'agent';
    } else {
      deleteHeaderInsensitive('requestId');
      deleteHeaderInsensitive('requestType');
    }

    return finalized;
  }

  protected override async postprocessResponse(response: unknown, _context: ProviderContext): Promise<UnknownObject> {
    if (response && typeof response === 'object') {
      return response as UnknownObject;
    }
    return { data: response } as UnknownObject;
  }

  private isAntigravityRuntime(): boolean {
    const fromConfig =
      typeof this.config?.config?.providerId === 'string' && this.config.config.providerId.trim()
        ? this.config.config.providerId.trim().toLowerCase()
        : '';
    const fromOAuth = typeof (this as any).oauthProviderId === 'string' ? String((this as any).oauthProviderId).trim().toLowerCase() : '';
    return fromConfig === 'antigravity' || fromOAuth === 'antigravity';
  }

  private getAntigravityHeaderMode(): 'minimal' | 'standard' | 'default' {
    const raw = (process.env.ROUTECODEX_ANTIGRAVITY_HEADER_MODE || process.env.RCC_ANTIGRAVITY_HEADER_MODE || '')
      .trim()
      .toLowerCase();
    if (raw === 'minimal' || raw === 'standard') {
      return raw as 'minimal' | 'standard';
    }
    return 'default';
  }

  private extractAntigravityAliasFromRuntime(): string | undefined {
    const runtime = this.getCurrentRuntimeMetadata();
    const candidates: string[] = [];
    if (runtime && typeof (runtime as any).runtimeKey === 'string') {
      candidates.push(String((runtime as any).runtimeKey));
    }
    if (runtime && typeof (runtime as any).providerKey === 'string') {
      candidates.push(String((runtime as any).providerKey));
    }
    for (const value of candidates) {
      const trimmed = value.trim();
      if (!trimmed.toLowerCase().startsWith('antigravity.')) {
        continue;
      }
      const parts = trimmed.split('.');
      if (parts.length >= 2 && parts[1] && parts[1].trim()) {
        return parts[1].trim();
      }
    }
    return undefined;
  }

  private resolveAntigravityStableSessionId(metadata: Record<string, unknown> | undefined): string | undefined {
    // Antigravity-Manager alignment: session_id is derived from the first user text (or JSON fallback),
    // unless the client explicitly provides a user_id. Do NOT derive from generic session/conversation ids.
    if (!metadata || typeof metadata !== 'object') {
      return undefined;
    }
    const userIdCandidateRaw =
      typeof (metadata as any)?.user_id === 'string'
        ? String((metadata as any).user_id)
        : typeof (metadata as any)?.metadata?.user_id === 'string'
          ? String((metadata as any).metadata.user_id)
          : '';
    const userIdCandidate = userIdCandidateRaw.trim();
    if (!userIdCandidate) {
      return undefined;
    }
    if (userIdCandidate.toLowerCase().includes('session-')) {
      return undefined;
    }
    return userIdCandidate;
  }

  private applyAntigravityRequestCompat(target: UnknownObject): void {
    const adapter = this.resolvePayload(target);
    const payload = adapter.payload;

    const metadata =
      target && typeof target === 'object' && typeof (target as any).metadata === 'object'
        ? ((target as any).metadata as Record<string, unknown>)
        : undefined;

    const headerMode = this.getAntigravityHeaderMode();
    const record = payload as Record<string, unknown>;

    if (headerMode !== 'minimal') {
      if (typeof record.userAgent !== 'string' || !record.userAgent.trim()) {
        record.userAgent = 'antigravity';
      }
      if (typeof record.requestType !== 'string' || !record.requestType.trim()) {
        const hasImageAttachment = metadata && (metadata.hasImageAttachment === true || metadata.hasImageAttachment === 'true');
        record.requestType = hasImageAttachment ? 'image_gen' : 'agent';
      }
    } else {
      delete (record as { userAgent?: unknown }).userAgent;
      delete (record as { requestType?: unknown }).requestType;
    }

    const existingReqId = record.requestId;
    const prefix = headerMode === 'minimal' ? 'req-' : 'agent-';
    if (typeof existingReqId !== 'string' || !existingReqId.trim().startsWith(prefix)) {
      record.requestId = `${prefix}${randomUUID()}`;
    }

    const alias = this.extractAntigravityAliasFromRuntime();
    const aliasKey = alias && alias.trim().length ? `antigravity.${alias.trim()}` : 'antigravity.unknown';
    const stableSessionId = this.resolveAntigravityStableSessionId(metadata);
    const derivedSessionId = extractAntigravityGeminiSessionId(target);
    const candidateSessionId = stableSessionId || (typeof derivedSessionId === 'string' ? derivedSessionId.trim() : '');
    if (candidateSessionId) {
      const lookup = lookupAntigravitySessionSignatureEntry(aliasKey, candidateSessionId, { hydrate: true });
      const hasSignature =
        typeof (lookup as any)?.signature === 'string' && String((lookup as any).signature).trim().length > 0;
      const sourceSessionId =
        hasSignature && typeof (lookup as any)?.sourceSessionId === 'string'
          ? String((lookup as any).sourceSessionId).trim()
          : '';
      const effectiveSessionId = sourceSessionId || candidateSessionId;
      const metaCarrier = target as { metadata?: Record<string, unknown> };
      metaCarrier.metadata = {
        ...(metaCarrier.metadata || {}),
        antigravitySessionId: effectiveSessionId,
        ...(effectiveSessionId !== candidateSessionId ? { antigravitySessionIdOriginal: candidateSessionId } : {})
      };
    }
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
