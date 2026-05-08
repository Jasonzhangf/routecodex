import { randomUUID } from 'node:crypto';
import { HttpTransportProvider } from './http-transport-provider.js';
import { GeminiSseNormalizer } from './gemini-sse-normalizer.js';
import { postprocessGeminiCliResponse } from './gemini-cli-response-postprocessor.js';
import type { OpenAIStandardConfig } from '../api/provider-config.js';
import type { ProviderContext, ProviderType } from '../api/provider-types.js';
import type { UnknownObject } from '../../../types/common-types.js';
import type { ModuleDependencies } from '../../../modules/pipeline/interfaces/pipeline-interfaces.js';
import {
  extractAntigravityGeminiSessionId,
  getAntigravityLatestSignatureSessionIdForAlias,
  lookupAntigravitySessionSignatureEntry
} from '../../../modules/llmswitch/bridge.js';
import { GeminiCLIProtocolClient } from '../../../client/gemini-cli/gemini-cli-protocol-client.js';
import { getDefaultProjectId } from '../../auth/gemini-cli-userinfo-helper.js';
import { resolveAntigravityApiBaseCandidates } from '../../auth/antigravity-userinfo-helper.js';
import { resolveAntigravityRequestTypeFromPayload } from './antigravity-request-type.js';


import {
  isAntigravityRuntime,
  resolveAntigravityStableSessionId,
  swapAntigravityRuntimeSessionId as swapAntigravitySessionId,
  restoreAntigravityRuntimeSessionId,
  wrapAntigravityHttpErrorAsResponse as wrapAntigravityErrorAsResponse,
} from './gemini-antigravity-mixin.js';

type DataEnvelope = UnknownObject & { data?: UnknownObject };

type MutablePayload = Record<string, unknown> & {
  model?: unknown;
  project?: unknown;
  action?: unknown;
};

export class GeminiCLIHttpProvider extends HttpTransportProvider {
  constructor(config: OpenAIStandardConfig, dependencies: ModuleDependencies) {
    const providerId =
      typeof config.config?.providerId === 'string' && config.config.providerId.trim().length
        ? config.config.providerId.trim()
        : 'gemini-cli';
    const cfg: OpenAIStandardConfig = {
      ...config,
      config: {
        ...config.config,
        providerType: 'gemini' as ProviderType,
        providerId,
        extensions: {
          ...(config.config?.extensions || {}),
          oauthProviderId: (config.config?.extensions as Record<string, unknown> | undefined)?.oauthProviderId ?? providerId
        }
      }
    };
    super(cfg, dependencies, 'gemini-cli-http-provider', new GeminiCLIProtocolClient());
  }

  protected override async sendRequestInternal(request: UnknownObject): Promise<unknown> {
    try {
      return await super.sendRequestInternal(request);
    } catch (error) {
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


  protected override getBaseUrlCandidates(_context: ProviderContext): string[] | undefined {
    if (!isAntigravityRuntime(this)) {
      return undefined;
    }
    return resolveAntigravityApiBaseCandidates(this.getEffectiveBaseUrl());
  }

  protected override async preprocessRequest(request: UnknownObject): Promise<UnknownObject> {
    const processedRequest = await super.preprocessRequest(request);
    const adapter = this.resolvePayload(processedRequest);
    const payload = adapter.payload as MutablePayload;
    const metadata =
      processedRequest && typeof processedRequest === 'object' && typeof (processedRequest as any).metadata === 'object'
        ? ((processedRequest as any).metadata as Record<string, unknown>)
        : undefined;

    if (!this.authProvider) {
      throw new Error('Gemini CLI: auth provider not found');
    }

    const anyAuth = this.authProvider as any;
    const readTokenPayload = (): UnknownObject | null | undefined => {
      const oauthClient = anyAuth.getOAuthClient?.();
      if (oauthClient && typeof oauthClient.getToken === 'function') {
        return oauthClient.getToken() as UnknownObject;
      }
      if (typeof anyAuth.getTokenPayload === 'function') {
        return anyAuth.getTokenPayload() as UnknownObject | null;
      }
      return undefined;
    };

    const tokenData = readTokenPayload();
    const projectId = getDefaultProjectId(tokenData || {});

    const model =
      typeof payload.model === 'string' && payload.model.trim().length > 0
        ? (payload.model as string)
        : '';
    if (!model) {
      throw new Error('Gemini CLI: model is required');
    }

    payload.model = model;
    if (projectId) {
      (payload as Record<string, unknown>).project = projectId;
    }

    this.ensureRequestMetadata(payload);

    const recordPayload = payload as Record<string, unknown>;
    const hasMessages = Array.isArray((recordPayload as { messages?: unknown }).messages);

    if (hasMessages) {
      delete recordPayload.messages;
    }
    delete (recordPayload as { stream?: unknown }).stream;

    if (isAntigravityRuntime(this)) {
      const headerMode = this.getAntigravityHeaderMode();
      const record = payload as Record<string, unknown>;
      if (headerMode !== 'minimal') {
        if (!this.hasNonEmptyString(record.userAgent)) {
          record.userAgent = 'antigravity';
        }
        if (!this.hasNonEmptyString(record.requestType)) {
          record.requestType = resolveAntigravityRequestTypeFromPayload(processedRequest);
        }
      } else {
        delete record.userAgent;
        delete record.requestType;
      }
      const existingReqId = record.requestId;
      const prefix = 'agent-';
      if (typeof existingReqId !== 'string' || !existingReqId.trim().startsWith(prefix)) {
        record.requestId = `${prefix}${randomUUID()}`;
      }
    }

    if (isAntigravityRuntime(this)) {
      const alias = this.extractAntigravityAliasFromRuntime();
      const aliasKey = alias && alias.trim().length ? `antigravity.${alias.trim()}` : 'antigravity.unknown';
      const stableSessionId = resolveAntigravityStableSessionId(metadata);
      const derivedSessionId = extractAntigravityGeminiSessionId(processedRequest);
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
        const metaCarrier = processedRequest as { metadata?: Record<string, unknown> };
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

    return processedRequest;
  }

  protected override wantsUpstreamSse(request: UnknownObject, context: ProviderContext): boolean {
    const fromRequest = this.extractStreamFlag(request);
    const fromContext = this.extractStreamFlag(context.metadata as UnknownObject);
    const isAntigravity = isAntigravityRuntime(this);
    const wantsStream =
      isAntigravity
        ? true
        : typeof fromRequest === 'boolean'
          ? fromRequest
          : typeof fromContext === 'boolean'
            ? fromContext
            : false;
    this.applyStreamAction(request, wantsStream);
    return wantsStream;
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

  private getAntigravityHeaderMode(): 'minimal' | 'standard' | 'default' {
    const raw = (process.env.ROUTECODEX_ANTIGRAVITY_HEADER_MODE || process.env.RCC_ANTIGRAVITY_HEADER_MODE || '')
      .trim()
      .toLowerCase();
    if (raw === 'minimal' || raw === 'standard') {
      return raw as 'minimal' | 'standard';
    }
    return 'default';
  }

  protected override async postprocessResponse(response: unknown, context: ProviderContext): Promise<UnknownObject> {
    return postprocessGeminiCliResponse({
      response,
      context,
      providerType: this.providerType,
      isAntigravityRuntime: isAntigravityRuntime(this),
      antigravityAlias: this.extractAntigravityAliasFromRuntime()
    });
  }

  protected override async wrapUpstreamSseResponse(
    stream: NodeJS.ReadableStream,
    context: ProviderContext
  ): Promise<UnknownObject> {
    const sessionId =
      context && typeof (context as any)?.runtimeMetadata?.metadata?.antigravitySessionId === 'string'
        ? String((context as any).runtimeMetadata.metadata.antigravitySessionId)
        : context && context.metadata && typeof context.metadata.antigravitySessionId === 'string'
          ? String(context.metadata.antigravitySessionId)
          : undefined;
    const alias = isAntigravityRuntime(this) ? this.extractAntigravityAliasFromRuntime() : undefined;
    const aliasKey = alias && alias.trim().length ? `antigravity.${alias.trim()}` : undefined;
    const normalizer = new GeminiSseNormalizer({ sessionId, aliasKey, enableAntigravitySignatureCache: isAntigravityRuntime(this) });
    stream.pipe(normalizer);
    return super.wrapUpstreamSseResponse(normalizer, context);
  }


  private resolvePayload(source: UnknownObject): {
    payload: MutablePayload;
    assign(updated: MutablePayload): UnknownObject;
  } {
    if (this.hasDataEnvelope(source)) {
      const envelope = source as DataEnvelope;
      const dataRecord = (envelope.data && typeof envelope.data === 'object')
        ? (envelope.data as MutablePayload)
        : {};
      if (!envelope.data || typeof envelope.data !== 'object') {
        envelope.data = dataRecord;
      }
      if (source && typeof source === 'object') {
        const sourceRecord = source as Record<string, unknown>;
        for (const [key, value] of Object.entries(sourceRecord)) {
          if (key === 'data' || key === 'metadata') {
            continue;
          }
          if ((dataRecord as Record<string, unknown>)[key] === undefined) {
            (dataRecord as Record<string, unknown>)[key] = value;
          }
        }
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

  protected hasDataEnvelope(payload: UnknownObject): payload is DataEnvelope {
    return typeof payload === 'object' && payload !== null && 'data' in payload;
  }

  private applyStreamAction(target: UnknownObject, wantsStream: boolean): void {
    const adapter = this.resolvePayload(target);
    const payload = adapter.payload as MutablePayload;
    if (wantsStream) {
      payload.action = 'streamGenerateContent';
      return;
    }
    if (!this.hasNonEmptyString(payload.action)) {
      payload.action = 'generateContent';
    }
  }

  private ensureRequestMetadata(payload: MutablePayload): void {
    const isAntigravity = isAntigravityRuntime(this);

    if (!this.hasNonEmptyString(payload.requestId)) {
      payload.requestId = isAntigravity ? `agent-${randomUUID()}` : `req-${randomUUID()}`;
    }
    if (isAntigravity) {
      delete (payload as { session_id?: unknown }).session_id;
    }
  }

  private hasNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
  }


  private extractStreamFlag(source: UnknownObject | undefined): boolean | undefined {
    if (!source || typeof source !== 'object') {
      return undefined;
    }
    const direct = (source as Record<string, unknown>).stream;
    if (typeof direct === 'boolean') {
      return direct;
    }
    const metadataContainer = (source as { metadata?: unknown }).metadata;
    if (metadataContainer && typeof metadataContainer === 'object') {
      const metaStream = (metadataContainer as Record<string, unknown>).stream;
      if (typeof metaStream === 'boolean') {
        return metaStream;
      }
    }
    const dataContainer = (source as { data?: unknown }).data;
    if (dataContainer && typeof dataContainer === 'object') {
      const nested = this.extractStreamFlag(dataContainer as UnknownObject);
      if (typeof nested === 'boolean') {
        return nested;
      }
    }
    return undefined;
  }


}

export default GeminiCLIHttpProvider;
