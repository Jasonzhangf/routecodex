/**
 * Gemini HTTP Provider (V2)
 *
 * 以 Gemini Chat 协议（gemini-chat）为目标，调用 Google Generative Language API。
 * - 默认基地址：https://generativelanguage.googleapis.com/v1beta
 * - 生成路径：/models/{model}:generateContent
 * - 认证：优先使用 header 'x-goog-api-key: <API_KEY>'；若仅提供 Authorization: Bearer <key>，自动转换为 x-goog-api-key。
 * - 形状转换：由 GeminiProtocolClient 统一处理（OpenAI Chat → Gemini contents/systemInstruction/generationConfig）。
 */

import { randomUUID } from 'node:crypto';
import { HttpTransportProvider } from './http-transport-provider.js';
import type { OpenAIStandardConfig } from '../api/provider-config.js';
import type { ProviderContext, ProviderType } from '../api/provider-types.js';
import type { UnknownObject } from '../../../types/common-types.js';
import type { ModuleDependencies } from '../../../modules/pipeline/interfaces/pipeline-interfaces.js';
import {
  extractAntigravityGeminiSessionId,
  getAntigravityLatestSignatureSessionIdForAlias,
  lookupAntigravitySessionSignatureEntry
} from '../../../modules/llmswitch/bridge.js';
import { GeminiProtocolClient } from '../../../client/gemini/gemini-protocol-client.js';

type DataEnvelope = UnknownObject & { data?: UnknownObject };

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

  protected override async sendRequestInternal(request: UnknownObject): Promise<unknown> {
    try {
      return await super.sendRequestInternal(request);
    } catch (error) {
      // Allow llmswitch-core ServerTool to intercept certain Antigravity/Gemini upstream failures
      // (e.g. thoughtSignature validator returning 429/400) by returning an error-shaped response
      // instead of throwing (so the response conversion + servertool orchestration can run).
      if (this.isAntigravityRuntime()) {
        const wrapped = this.wrapAntigravityHttpErrorAsResponse(error);
        if (wrapped) {
          return wrapped;
        }
      }
      throw error;
    } finally {
      this.restoreAntigravityRuntimeSessionId();
    }
  }

  protected override async preprocessRequest(request: UnknownObject): Promise<UnknownObject> {
    const processedRequest = await super.preprocessRequest(request);
    if (this.isAntigravityRuntime()) {
      this.applyAntigravityRequestCompat(processedRequest);
    }
    return processedRequest;
  }


  protected override async postprocessResponse(response: unknown, _context: ProviderContext): Promise<UnknownObject> {
    if (response && typeof response === 'object') {
      return response as UnknownObject;
    }
    return { data: response } as UnknownObject;
  }

  private wrapAntigravityHttpErrorAsResponse(error: unknown): UnknownObject | null {
    const err = error as {
      statusCode?: unknown;
      status?: unknown;
      response?: { data?: unknown; raw?: unknown; status?: unknown };
      headers?: unknown;
      message?: unknown;
    };
    const status =
      typeof err?.statusCode === 'number'
        ? err.statusCode
        : typeof err?.status === 'number'
          ? err.status
          : typeof err?.response?.status === 'number'
            ? err.response.status
            : undefined;
    if (typeof status !== 'number' || !Number.isFinite(status)) {
      return null;
    }

    const message = typeof err?.message === 'string' ? err.message : String(err?.message ?? '');
    const looksLikeSignatureError =
      status === 429 ||
      (status === 400 && /signature/i.test(message));
    if (!looksLikeSignatureError) {
      return null;
    }

    const data =
      err?.response && typeof err.response === 'object' && 'data' in err.response
        ? (err.response as { data?: unknown }).data
        : undefined;
    const errorBody =
      data && typeof data === 'object' && !Array.isArray(data)
        ? (data as Record<string, unknown>)
        : {
            error: {
              code: status,
              message: message || `HTTP ${status}`,
              status
            }
          };
    const headers =
      err?.headers && typeof err.headers === 'object' && !Array.isArray(err.headers)
        ? (err.headers as Record<string, unknown>)
        : undefined;

    return {
      status,
      ...(headers ? { headers } : {}),
      data: errorBody
    } as UnknownObject;
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
    const prefix = 'agent-';
    if (typeof existingReqId !== 'string' || !existingReqId.trim().startsWith(prefix)) {
      record.requestId = `${prefix}${randomUUID()}`;
    }

    const alias = this.extractAntigravityAliasFromRuntime();
    const aliasKey = alias && alias.trim().length ? `antigravity.${alias.trim()}` : 'antigravity.unknown';
    const stableSessionId = this.resolveAntigravityStableSessionId(metadata);
    const derivedSessionId = extractAntigravityGeminiSessionId(target);
    const candidateSessionId = stableSessionId || (typeof derivedSessionId === 'string' ? derivedSessionId.trim() : '');
    if (candidateSessionId) {
      const lookupCandidate = lookupAntigravitySessionSignatureEntry(aliasKey, candidateSessionId, { hydrate: true });
      const candidateHasSignature =
        typeof (lookupCandidate as any)?.signature === 'string' && String((lookupCandidate as any).signature).trim().length > 0;

      let effectiveSessionId = candidateSessionId;
      if (!candidateHasSignature) {
        const latestSid = getAntigravityLatestSignatureSessionIdForAlias(aliasKey, { hydrate: true });
        if (latestSid && latestSid !== candidateSessionId) {
          const lookupLatest = lookupAntigravitySessionSignatureEntry(aliasKey, latestSid, { hydrate: true });
          const latestHasSignature =
            typeof (lookupLatest as any)?.signature === 'string' && String((lookupLatest as any).signature).trim().length > 0;
          if (latestHasSignature) {
            effectiveSessionId = latestSid;
          }
        }
      }
      const metaCarrier = target as { metadata?: Record<string, unknown> };
      metaCarrier.metadata = {
        ...(metaCarrier.metadata || {}),
        antigravitySessionId: effectiveSessionId,
        ...(effectiveSessionId !== candidateSessionId ? { antigravitySessionIdOriginal: candidateSessionId } : {})
      };
      if (effectiveSessionId !== candidateSessionId) {
        this.swapAntigravityRuntimeSessionId(effectiveSessionId, candidateSessionId);
      }
    }
  }

  private swapAntigravityRuntimeSessionId(effectiveSessionId: string, originalSessionId: string): void {
    if (!this.isAntigravityRuntime()) {
      return;
    }
    const runtime = this.getCurrentRuntimeMetadata();
    const meta = runtime?.metadata;
    if (!meta || typeof meta !== 'object') {
      return;
    }
    const record = meta as Record<string, unknown>;
    if (!('__antigravitySessionIdRestore' in record)) {
      record.__antigravitySessionIdRestore = typeof record.antigravitySessionId === 'string' ? record.antigravitySessionId : null;
      record.__antigravitySessionIdOriginalRestore =
        typeof record.antigravitySessionIdOriginal === 'string' ? record.antigravitySessionIdOriginal : null;
    }
    record.antigravitySessionId = effectiveSessionId;
    record.antigravitySessionIdOriginal = originalSessionId;
  }

  private restoreAntigravityRuntimeSessionId(): void {
    if (!this.isAntigravityRuntime()) {
      return;
    }
    const runtime = this.getCurrentRuntimeMetadata();
    const meta = runtime?.metadata;
    if (!meta || typeof meta !== 'object') {
      return;
    }
    const record = meta as Record<string, unknown>;
    if (!('__antigravitySessionIdRestore' in record)) {
      return;
    }
    const restore = record.__antigravitySessionIdRestore;
    const restoreOriginal = record.__antigravitySessionIdOriginalRestore;
    delete record.__antigravitySessionIdRestore;
    delete record.__antigravitySessionIdOriginalRestore;
    if (typeof restore === 'string' && restore.trim().length) {
      record.antigravitySessionId = restore;
    } else {
      delete record.antigravitySessionId;
    }
    if (typeof restoreOriginal === 'string' && restoreOriginal.trim().length) {
      record.antigravitySessionIdOriginal = restoreOriginal;
    } else {
      delete record.antigravitySessionIdOriginal;
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


}

export default GeminiHttpProvider;
