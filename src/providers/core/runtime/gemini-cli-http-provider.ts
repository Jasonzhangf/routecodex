/**
 * Gemini CLI HTTP Provider
 *
 * 以 Gemini CLI 协议（gemini-cli）为目标，调用 Google Cloud Code Assist API。
 * - 默认基地址：https://cloudcode-pa.googleapis.com/v1internal
 * - 生成路径：/:generateContent, /:streamGenerateContent, /:countTokens
 * - 认证：OAuth2 Bearer token
 * - 特性：多 project 支持、token 共享、模型回退
 */

import { randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import type { TransformCallback } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { HttpTransportProvider } from './http-transport-provider.js';
// ...
import type { OpenAIStandardConfig } from '../api/provider-config.js';
import type { ProviderContext, ProviderType } from '../api/provider-types.js';
import type { UnknownObject } from '../../../types/common-types.js';
import type { ModuleDependencies } from '../../../modules/pipeline/interfaces/pipeline-interfaces.js';
import { GeminiCLIProtocolClient } from '../../../client/gemini-cli/gemini-cli-protocol-client.js';
import { getDefaultProjectId } from '../../auth/gemini-cli-userinfo-helper.js';
import { ANTIGRAVITY_HELPER_DEFAULTS, resolveAntigravityApiBaseCandidates } from '../../auth/antigravity-userinfo-helper.js';

type DataEnvelope = UnknownObject & { data?: UnknownObject };

type MutablePayload = Record<string, unknown> & {
  model?: unknown;
  project?: unknown;
  action?: unknown;
  // 以下字段按“已经是 Gemini 协议”对待，由 llmswitch-core 负责从 OpenAI/Responses 映射过来
  // contents?: unknown;
  // systemInstruction?: unknown;
  // generationConfig?: Record<string, unknown>;
};

// Antigravity transport contract: a stable per-process session seed (plugin-style session semantics).
const ANTIGRAVITY_PLUGIN_SESSION_ID = `-${randomUUID()}`;

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
        // 使用统一的 providerType=gemini，表示协议族与标准 Gemini 一致
        // gemini-cli 仅作为 Cloud Code Assist 变体，通过模块类型 + auth 配置区分
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

  protected override applyStreamModeHeaders(headers: Record<string, string>, wantsSse: boolean): Record<string, string> {
    if (!this.isAntigravityRuntime()) {
      return super.applyStreamModeHeaders(headers, wantsSse);
    }
    if (this.getAntigravityHeaderMode() === 'minimal') {
      return { ...headers, Accept: '*/*' };
    }
    // Antigravity manager alignment: keep standard SSE Accept header behavior.
    return super.applyStreamModeHeaders(headers, wantsSse);
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

    // 从 auth provider 获取 project_id（仅做最小的 OAuth token 解析，不在此处触发 OAuth 流程）
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
        // 兼容 TokenFileAuthProvider：直接从本地 token JSON 解析 project_id
        return anyAuth.getTokenPayload() as UnknownObject | null;
      }
      return undefined;
    };

    const tokenData = readTokenPayload();
    const projectId = getDefaultProjectId(tokenData || {});

    // 构建 Gemini CLI 格式的请求（仅做传输层整理，不做 OpenAI→Gemini 语义转换）
    const model =
      typeof payload.model === 'string' && payload.model.trim().length > 0
        ? (payload.model as string)
        : '';
    if (!model) {
      throw new Error('Gemini CLI: model is required');
    }

    payload.model = model;
    // 若当前 token 中已有 project 元数据，则补充到请求中；否则让上游决定后续行为。
    // 注意：Antigravity 运行时保持与早期成功快照一致，始终显式发送 project。
    if (projectId) {
      (payload as Record<string, unknown>).project = projectId;
    }

    this.ensureRequestMetadata(payload);

    // 删除与 Gemini 协议无关的字段，避免影响 Cloud Code Assist schema 校验。
    const recordPayload = payload as Record<string, unknown>;
    // 按 gcli2api 语义：协议层不主动删 tools，只做最小形状整理。
    const hasMessages = Array.isArray((recordPayload as { messages?: unknown }).messages);

    if (hasMessages) {
      // OpenAI/Responses 桥接场景：messages 已在上游映射为 contents，这里只去掉重复字段。
      delete recordPayload.messages;
    }
    // 无论是否来自 messages 桥接，都不向上游发送 OpenAI 的 stream 标记。
    delete (recordPayload as { stream?: unknown }).stream;

    // Standard contract: Antigravity identity fields are carried in the JSON wrapper (not headers).
    // Provider must not infer request semantics from user payload; modality hints must come from llmswitch-core metadata.
    if (this.isAntigravityRuntime()) {
      const headerMode = this.getAntigravityHeaderMode();
      const record = payload as Record<string, unknown>;
      if (headerMode !== 'minimal') {
        if (!this.hasNonEmptyString(record.userAgent)) {
          record.userAgent = 'antigravity';
        }
        if (!this.hasNonEmptyString(record.requestType)) {
          const hasImageAttachment =
            metadata && (metadata.hasImageAttachment === true || metadata.hasImageAttachment === 'true');
          record.requestType = hasImageAttachment ? 'image_gen' : 'agent';
        }
      } else {
        delete record.userAgent;
        delete record.requestType;
      }
      const existingReqId = record.requestId;
      const prefix = headerMode === 'minimal' ? 'req-' : 'agent-';
      if (typeof existingReqId !== 'string' || !existingReqId.trim().startsWith(prefix)) {
        record.requestId = `${prefix}${randomUUID()}`;
      }
    }

    return processedRequest;
  }

  protected override wantsUpstreamSse(request: UnknownObject, context: ProviderContext): boolean {
    const fromRequest = this.extractStreamFlag(request);
    const fromContext = this.extractStreamFlag(context.metadata as UnknownObject);
    const isAntigravity = this.isAntigravityRuntime();
    const wantsStream =
      // 对 Antigravity 运行时强制走 SSE，以对齐 /v1/responses 上稳定的 streamGenerateContent 行为，
      // 避免非流式 generateContent 触发上游配额/限流策略差异。
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

  protected override async finalizeRequestHeaders(
    headers: Record<string, string>,
    request: UnknownObject
  ): Promise<Record<string, string>> {
    const finalized = await super.finalizeRequestHeaders(headers, request);
    if (this.isAntigravityRuntime()) {
      const headerMode = this.getAntigravityHeaderMode();
      const deleteHeaderInsensitive = (key: string): void => {
        const target = key.toLowerCase();
        for (const k of Object.keys(finalized)) {
          if (k.toLowerCase() === target) {
            delete finalized[k];
          }
        }
      };

      const envUa = (process.env.ROUTECODEX_ANTIGRAVITY_USER_AGENT || process.env.RCC_ANTIGRAVITY_USER_AGENT || '').trim();
      const defaultUa = ANTIGRAVITY_HELPER_DEFAULTS.userAgent;
      finalized['User-Agent'] = envUa || defaultUa;
      // gcli2api alignment: keep headers minimal for Antigravity.
      finalized['Accept-Encoding'] = 'gzip';
      deleteHeaderInsensitive('originator');
      if (headerMode === 'minimal') {
        const record = request as Record<string, unknown>;
        const reqId = typeof record.requestId === 'string' ? record.requestId : undefined;
        if (reqId && reqId.trim()) {
          finalized.requestId = reqId;
        }
        const hasImageAttachment =
          (request as any)?.metadata && (((request as any).metadata as Record<string, unknown>).hasImageAttachment === true ||
            ((request as any).metadata as Record<string, unknown>).hasImageAttachment === 'true');
        finalized.requestType = hasImageAttachment ? 'image_gen' : 'agent';
      } else {
        deleteHeaderInsensitive('requestId');
        deleteHeaderInsensitive('requestType');
      }
    }
    return finalized;
  }

  protected override buildHttpRequestBody(request: UnknownObject): UnknownObject {
    return super.buildHttpRequestBody(request);
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
    const processingTime = Date.now() - context.startTime;

    if (response && typeof response === 'object') {
      const record = response as {
        data?: unknown;
        status?: number;
        headers?: Record<string, string>;
        __sse_responses?: unknown;
      };

      // 保持与基类一致：优先透传上游 SSE 流
      const sseStream =
        record.__sse_responses ||
        (record.data && typeof record.data === 'object'
          ? (record.data as { __sse_responses?: unknown }).__sse_responses
          : undefined);
      if (sseStream) {
        return { __sse_responses: sseStream } as UnknownObject;
      }

      // 非流式响应：HttpClient.post 返回的 data 是 Cloud Code Assist 的 envelope：{ response: <GeminiResponse>, ... }
      const rawData = record.data ?? response;
      let normalizedPayload = rawData as unknown;
      if (rawData && typeof rawData === 'object' && 'response' in (rawData as Record<string, unknown>)) {
        const inner = (rawData as Record<string, unknown>).response;
        if (inner && typeof inner === 'object') {
          normalizedPayload = inner as Record<string, unknown>;
        }
      }

      const payloadObject =
        normalizedPayload && typeof normalizedPayload === 'object'
          ? (normalizedPayload as Record<string, unknown>)
          : undefined;

      const modelFromPayload =
        payloadObject && typeof payloadObject.model === 'string' && payloadObject.model.trim().length
          ? payloadObject.model
          : undefined;

      const usageFromPayload =
        payloadObject && typeof (payloadObject as { usageMetadata?: unknown }).usageMetadata === 'object'
          ? ((payloadObject as { usageMetadata?: UnknownObject }).usageMetadata as UnknownObject)
          : undefined;

      return {
        data: normalizedPayload,
        status: typeof record.status === 'number' ? record.status : undefined,
        headers: record.headers,
        metadata: {
          requestId: context.requestId,
          processingTime,
          providerType: this.providerType,
          model: context.model ?? modelFromPayload,
          usage: usageFromPayload
        }
      } as UnknownObject;
    }

    // 基本兜底：保留处理时间和 requestId，数据直接透传
    return {
      data: response,
      metadata: {
        requestId: context.requestId,
        processingTime,
        providerType: this.providerType,
        model: context.model
      }
    } as UnknownObject;
  }

  protected override async wrapUpstreamSseResponse(
    stream: NodeJS.ReadableStream,
    context: ProviderContext
  ): Promise<UnknownObject> {
    const normalizer = new GeminiSseNormalizer();
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

  /**
   * 获取模型回退列表（用于处理 429 限流）
   * 参考 CLIProxyAPI 的 cliPreviewFallbackOrder
   */
  protected getFallbackModels(model: string): string[] {
    const fallbackMap: Record<string, string[]> = {
      'gemini-2.5-pro': ['gemini-2.5-pro-preview-06-05'],
      'gemini-2.5-flash': [],
      'gemini-2.5-flash-lite': []
    };
    return fallbackMap[model] || [];
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
    // gcli2api alignment: Antigravity request bodies are minimal; do not inject session_id/userAgent/requestType
    // or generationConfig defaults at the provider layer.
    if (isAntigravity) {
      delete (payload as { session_id?: unknown }).session_id;
    }
  }

  private buildAntigravitySignatureSessionKey(options: {
    model: string;
    project: string;
    conversationKey: string;
  }): string {
    const modelKeyRaw = typeof options.model === 'string' ? options.model.trim().toLowerCase() : 'unknown';
    // Antigravity contract: strip tier suffix to reduce cache misses when tier changes.
    const modelKey = modelKeyRaw.replace(/-(minimal|low|medium|high)$/i, '');
    const projectPart = typeof options.project === 'string' && options.project.trim().length ? options.project.trim() : 'default';
    const conversationPart =
      typeof options.conversationKey === 'string' && options.conversationKey.trim().length
        ? options.conversationKey.trim()
        : 'default';
    return `${ANTIGRAVITY_PLUGIN_SESSION_ID}:${modelKey}:${projectPart}:${conversationPart}`;
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

class GeminiSseNormalizer extends Transform {
  private decoder: StringDecoder;
  private buffer = '';
  private lastDonePayload: Record<string, unknown> | null = null;
  private eventCounter = 0;
  private chunkCounter = 0;
  private processedEventCounter = 0;
  private capturedEvents: any[] = [];

  constructor() {
    super();
    this.decoder = new StringDecoder('utf8');
  }

  override _transform(chunk: unknown, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.chunkCounter++;
    if (chunk) {
      let text = '';
      if (Buffer.isBuffer(chunk)) {
        text = this.decoder.write(chunk);
      } else {
        // If we receive strings, convert to buffer to maintain decoder state safety
        // or assume separate handling. Safe approach: treat as bytes.
        text = this.decoder.write(Buffer.from(String(chunk), 'utf8'));
      }
      // Upstream can use CRLF (\r\n), and chunk boundaries may split \r and \n.
      // Normalize by removing all \r so the event separator is always \n\n.
      this.buffer += text.replace(/\r/g, '');
      this.processBuffered();
    }
    callback();
  }

  override _flush(callback: TransformCallback): void {
    const remaining = this.decoder.end();
    if (remaining) {
      this.buffer += remaining.replace(/\r/g, '');
    }
    this.processBuffered(true);
    if (this.lastDonePayload) {
      this.pushEvent('gemini.done', this.lastDonePayload);
      this.lastDonePayload = null;
    }
    callback();
  }

  private processBuffered(flush = false): void {
    let eventsFound = 0;
    while (true) {
      const separatorIndex = this.buffer.indexOf('\n\n');
      if (separatorIndex === -1) {
        break;
      }
      eventsFound++;
      const rawEvent = this.buffer.slice(0, separatorIndex);
      this.buffer = this.buffer.slice(separatorIndex + 2);
      this.processEvent(rawEvent);
    }
    if (flush && this.buffer.trim().length) {
      this.processEvent(this.buffer);
      this.buffer = '';
    }
  }

  private processEvent(rawEvent: string): void {
    this.processedEventCounter++;
    const trimmed = rawEvent.trim();
    if (!trimmed.length) {
      return;
    }
    const dataLines = trimmed
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart());
    if (!dataLines.length) {
      return;
    }
    const payloadText = dataLines.join('\n').trim();
    if (!payloadText || payloadText === '[DONE]') {
      return;
    }
    try {
      const parsed = JSON.parse(payloadText) as { response?: Record<string, unknown> };
      this.capturedEvents.push(parsed);
      const response = parsed?.response;
      if (!response || typeof response !== 'object') {
        return;
      }
      this.emitCandidateParts(response as Record<string, unknown>);
    } catch (err) {
      // ignore parse errors; upstream stream snapshots (if enabled) are used for debugging
    }
  }

  private emitCandidateParts(response: Record<string, unknown>): void {
    const candidatesRaw = (response as { candidates?: unknown }).candidates;
    const candidates = Array.isArray(candidatesRaw) ? (candidatesRaw as Record<string, unknown>[]) : [];

    candidates.forEach((candidate, index) => {
      const content =
        candidate && typeof candidate.content === 'object' && candidate.content !== null
          ? (candidate.content as Record<string, unknown>)
          : undefined;
      const role = typeof content?.role === 'string' ? (content.role as string) : 'model';
      const partsRaw = content?.parts;
      const parts = Array.isArray(partsRaw) ? (partsRaw as Record<string, unknown>[]) : [];

      for (const part of parts) {
        if (!part || typeof part !== 'object') {continue;}

        // Send raw Gemini part - let llmswitch-core handle the conversion to target protocol
        this.pushEvent('gemini.data', {
          candidateIndex: index,
          role,
          part  // ← Raw Gemini part object
        });
      }
    });

    // Preserve finish reason, safety ratings, and usage metadata
    this.lastDonePayload = {
      candidates: candidates.map((candidate, index) => ({
        index,
        finishReason:
          candidate && typeof candidate === 'object'
            ? ((candidate as Record<string, unknown>).finishReason as unknown)
            : undefined,
        safetyRatings:
          candidate && typeof candidate === 'object'
            ? ((candidate as Record<string, unknown>).safetyRatings as unknown)
            : undefined
      })),
      usageMetadata: (response as { usageMetadata?: unknown }).usageMetadata,
      promptFeedback: (response as { promptFeedback?: unknown }).promptFeedback,
      modelVersion: (response as { modelVersion?: unknown }).modelVersion
    };
  }

  private pushEvent(eventName: string, payload: Record<string, unknown>): void {
    this.eventCounter++;
    try {
      const data = JSON.stringify(payload);
      this.push(`event: ${eventName}\ndata: ${data}\n\n`);
    } catch {
      // ignore serialization errors
    }
  }
}
