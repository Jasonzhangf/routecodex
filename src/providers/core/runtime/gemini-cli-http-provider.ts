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
import { ANTIGRAVITY_HELPER_DEFAULTS } from '../../auth/antigravity-userinfo-helper.js';

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

  protected override async preprocessRequest(request: UnknownObject): Promise<UnknownObject> {
    const processedRequest = await super.preprocessRequest(request);
    const adapter = this.resolvePayload(processedRequest);
    const payload = adapter.payload as MutablePayload;

    // 从 auth provider 获取 project_id（仅做最小的 OAuth token 解析，不介入登录流程）
    if (!this.authProvider) {
      throw new Error('Gemini CLI: auth provider not found');
    }

    const anyAuth = this.authProvider as any;
    let tokenData: UnknownObject | null | undefined;

    const oauthClient = anyAuth.getOAuthClient?.();
    if (oauthClient && typeof oauthClient.getToken === 'function') {
      tokenData = oauthClient.getToken() as UnknownObject;
    } else if (typeof anyAuth.getTokenPayload === 'function') {
      // 兼容 TokenFileAuthProvider：直接从本地 token JSON 解析 project_id
      tokenData = anyAuth.getTokenPayload() as UnknownObject | null;
    }

    const projectId = getDefaultProjectId(tokenData || {});

    if (!projectId) {
      throw new Error(
        'Gemini CLI: project_id not found in token. Please authenticate with Google OAuth first.'
      );
    }

    // 构建 Gemini CLI 格式的请求（仅做传输层整理，不做 OpenAI→Gemini 语义转换）
    const model =
      typeof payload.model === 'string' && payload.model.trim().length > 0
        ? (payload.model as string)
        : '';
    if (!model) {
      throw new Error('Gemini CLI: model is required');
    }

    payload.model = model;
    payload.project = projectId;
    this.ensureRequestMetadata(payload);

    // 删除与 Gemini 协议无关的字段，避免影响 Cloud Code Assist schema 校验
    delete (payload as Record<string, unknown>).messages;
    delete (payload as Record<string, unknown>).stream;

    return processedRequest;
  }

  protected override wantsUpstreamSse(request: UnknownObject, context: ProviderContext): boolean {
    const fromRequest = this.extractStreamFlag(request);
    const fromContext = this.extractStreamFlag(context.metadata as UnknownObject);
    const wantsStream =
      typeof fromRequest === 'boolean'
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
      finalized['User-Agent'] = ANTIGRAVITY_HELPER_DEFAULTS.userAgent;
      if (!this.hasNonEmptyString(finalized['Accept-Encoding'])) {
        finalized['Accept-Encoding'] = 'gzip, deflate, br';
      }
    }
    return finalized;
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
    return (this.oauthProviderId || '').toLowerCase() === 'antigravity';
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
    if (!this.hasNonEmptyString(payload.requestId)) {
      payload.requestId = `req-${randomUUID()}`;
    }
    if (!this.hasNonEmptyString(payload.session_id)) {
      payload.session_id = `session-${randomUUID()}`;
    }
    if (!this.hasNonEmptyString(payload.userAgent)) {
      payload.userAgent = this.oauthProviderId === 'antigravity' ? 'antigravity' : 'routecodex';
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

class GeminiSseNormalizer extends Transform {
  private decoder: StringDecoder;
  private buffer = '';
  private lastDonePayload: Record<string, unknown> | null = null;
  private eventCounter = 0;
  private chunkCounter = 0;
  private processedEventCounter = 0;

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
      this.buffer += text.replace(/\r\n/g, '\n');
      this.processBuffered();
    }
    callback();
  }

  override _flush(callback: TransformCallback): void {
    const remaining = this.decoder.end();
    if (remaining) {
      this.buffer += remaining.replace(/\r\n/g, '\n');
    }
    this.processBuffered(true);

    console.log('[GeminiSseNormalizer] Stream complete:', {
      totalChunks: this.chunkCounter,
      processedEvents: this.processedEventCounter,
      emittedEvents: this.eventCounter
    });

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
      console.log('[GeminiSseNormalizer] Final buffer flush:', {
        bufferLength: this.buffer.length,
        bufferPreview: this.buffer.slice(0, 300),
        eventsFoundInLoop: eventsFound
      });
      this.processEvent(this.buffer);
      this.buffer = '';
    } else if (flush) {
      console.log('[GeminiSseNormalizer] Flush called but buffer empty:', {
        eventsFoundInLoop: eventsFound
      });
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
      const response = parsed?.response;
      if (!response || typeof response !== 'object') {
        // Log dropped events for debugging
        console.warn('[GeminiSseNormalizer] Dropped event without valid response field:', {
          hasResponse: !!parsed?.response,
          parsedKeys: Object.keys(parsed || {}),
          payloadPreview: payloadText.slice(0, 150)
        });
        return;
      }
      this.emitCandidateParts(response as Record<string, unknown>);
    } catch (err) {
      // Log parse failures for debugging
      console.error('[GeminiSseNormalizer] Failed to parse SSE payload:', {
        error: err instanceof Error ? err.message : String(err),
        payloadPreview: payloadText.slice(0, 200)
      });
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
        if (!part || typeof part !== 'object') continue;

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
