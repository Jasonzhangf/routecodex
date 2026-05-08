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
import { resolveAntigravityRequestTypeFromPayload } from './antigravity-request-type.js';
import {
  isAntigravityRuntime,
  getAntigravityHeaderMode,
  extractAntigravityAliasFromRuntime,
  resolveAntigravityStableSessionId,
  swapAntigravityRuntimeSessionId as swapAntigravitySessionId,
  restoreAntigravityRuntimeSessionId,
  wrapAntigravityHttpErrorAsResponse as wrapAntigravityErrorAsResponse,
} from './gemini-antigravity-mixin.js';

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
      if (isAntigravityRuntime(this)) {
        const wrapped = wrapAntigravityErrorAsResponse(error);
        if (wrapped) {
          return wrapped;
        }
      }
      throw error;
    } finally {
      restoreAntigravityRuntimeSessionId(this);
    }
  }

  protected override async preprocessRequest(request: UnknownObject): Promise<UnknownObject> {
    const processedRequest = await super.preprocessRequest(request);
    if (isAntigravityRuntime(this)) {
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



  private getAntigravityHeaderMode(): 'minimal' | 'standard' | 'default' {
    const raw = (process.env.ROUTECODEX_ANTIGRAVITY_HEADER_MODE || process.env.RCC_ANTIGRAVITY_HEADER_MODE || '')
      .trim()
      .toLowerCase();
    if (raw === 'minimal' || raw === 'standard') {
      return raw as 'minimal' | 'standard';
    }
    return 'default';
  }



  private applyAntigravityRequestCompat(target: UnknownObject): void {
    const adapter = this.resolvePayload(target);
    const payload = adapter.payload;

    const metadata =
      target && typeof target === 'object' && typeof (target as any).metadata === 'object'
        ? ((target as any).metadata as Record<string, unknown>)
        : undefined;

    const headerMode = getAntigravityHeaderMode();
    const record = payload as Record<string, unknown>;

    if (headerMode !== 'minimal') {
      if (typeof record.userAgent !== 'string' || !record.userAgent.trim()) {
        record.userAgent = 'antigravity';
      }
      if (typeof record.requestType !== 'string' || !record.requestType.trim()) {
        record.requestType = resolveAntigravityRequestTypeFromPayload(target);
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

    const alias = extractAntigravityAliasFromRuntime(this);
    const aliasKey = alias && alias.trim().length ? `antigravity.${alias.trim()}` : 'antigravity.unknown';
    const stableSessionId = resolveAntigravityStableSessionId(metadata);
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
        swapAntigravitySessionId(this, effectiveSessionId, candidateSessionId);
      }
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
