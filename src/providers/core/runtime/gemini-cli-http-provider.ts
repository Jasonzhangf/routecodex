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

  protected override getBaseUrlCandidates(_context: ProviderContext): string[] | undefined {
    if (!this.isAntigravityRuntime()) {
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

    if (this.isAntigravityRuntime()) {
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

    if (this.isAntigravityRuntime()) {
      const alias = this.extractAntigravityAliasFromRuntime();
      const aliasKey = alias && alias.trim().length ? `antigravity.${alias.trim()}` : 'antigravity.unknown';
      const stableSessionId = this.resolveAntigravityStableSessionId(metadata);
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
          this.swapAntigravityRuntimeSessionId(effectiveSessionId, candidateSessionId);
        }
      }
    }

    return processedRequest;
  }

  protected override wantsUpstreamSse(request: UnknownObject, context: ProviderContext): boolean {
    const fromRequest = this.extractStreamFlag(request);
    const fromContext = this.extractStreamFlag(context.metadata as UnknownObject);
    const isAntigravity = this.isAntigravityRuntime();
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
      isAntigravityRuntime: this.isAntigravityRuntime(),
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
    const alias = this.isAntigravityRuntime() ? this.extractAntigravityAliasFromRuntime() : undefined;
    const aliasKey = alias && alias.trim().length ? `antigravity.${alias.trim()}` : undefined;
    const normalizer = new GeminiSseNormalizer({ sessionId, aliasKey, enableAntigravitySignatureCache: this.isAntigravityRuntime() });
    stream.pipe(normalizer);
    return super.wrapUpstreamSseResponse(normalizer, context);
  }

  private isAntigravityRuntime(): boolean {
    const fromConfig =
      typeof this.config?.config?.providerId === 'string' && this.config.config.providerId.trim()
        ? this.config.config.providerId.trim().toLowerCase()
        : '';
    const fromOAuth = typeof this.oauthProviderId === 'string' ? this.oauthProviderId.trim().toLowerCase() : '';
    return fromConfig === 'antigravity' || fromOAuth === 'antigravity';
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
    const isAntigravity = this.isAntigravityRuntime();

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

  private resolveAntigravityStableSessionId(metadata: Record<string, unknown> | undefined): string | undefined {
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
}

export default GeminiCLIHttpProvider;
