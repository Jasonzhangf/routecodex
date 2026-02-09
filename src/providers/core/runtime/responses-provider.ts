/**
 * ResponsesProvider - 真实 OpenAI Responses SSE 透传 Provider
 *
 * 最小实现：继承 ChatHttpProvider，覆写 ServiceProfile 与发送路径，
 * 在 /v1/responses 入口下一律走上游 /responses 并使用 SSE（Accept: text/event-stream）。
 */

import { HttpTransportProvider } from './http-transport-provider.js';
import type { OpenAIStandardConfig } from '../api/provider-config.js';
import type { ModuleDependencies } from '../../../modules/pipeline/interfaces/pipeline-interfaces.js';
import type { ServiceProfile, ProviderContext } from '../api/provider-types.js';
import type { UnknownObject } from '../../../types/common-types.js';
import {
  attachProviderSseSnapshotStream,
  shouldCaptureProviderStreamSnapshots,
  writeProviderSnapshot
} from '../utils/snapshot-writer.js';
import {
  createResponsesSseToJsonConverter
} from '../../../modules/llmswitch/bridge.js';
import type { HttpClient } from '../utils/http-client.js';
import { ResponsesProtocolClient } from '../../../client/responses/responses-protocol-client.js';
import { emitProviderError, buildRuntimeFromProviderContext } from '../utils/provider-error-reporter.js';

type ResponsesHttpClient = Pick<HttpClient, 'post' | 'postStream'>;
type ResponsesStreamingMode = 'auto' | 'always' | 'never';
type ResponsesSseConverter = {
  convertSseToJson(stream: unknown, options: { requestId: string; model: string }): Promise<unknown>;
};
type ResponsesProviderConfig = {
  streaming?: ResponsesStreamingMode;
};

type SubmitToolOutputsPayload = {
  responseId: string;
  body: Record<string, unknown>;
};
export class ResponsesProvider extends HttpTransportProvider {
  private readonly responsesClient: ResponsesProtocolClient;

  constructor(config: OpenAIStandardConfig, dependencies: ModuleDependencies) {
    const cfg = extractResponsesConfig(config as unknown as UnknownObject);
    const streamingPref: ResponsesStreamingMode = cfg.streaming ?? 'auto';
    const responsesClient = new ResponsesProtocolClient({
      streaming: streamingPref,
      betaVersion: 'responses-2024-12-17'
    });
    super(config, dependencies, 'responses-http-provider', responsesClient);
    this.responsesClient = responsesClient;
  }

  /**
   * 使用 OpenAI 基础档案，但将默认 endpoint 改为 /responses。
   */
  protected override getServiceProfile(): ServiceProfile {
    const base = super.getServiceProfile();
    return {
      ...base,
      defaultEndpoint: '/responses'
    } as ServiceProfile;
  }

  /**
   * 覆写内部发送：/v1/responses 入口时按配置选择上游 SSE 或 JSON。
   * stream 标志主要影响 Host -> Client 是否用 SSE，上游传输模式由 ResponsesStreamingMode 控制。
   * 对于 SSE 模式，Provider 必须将上游 SSE 解析为 JSON 再返回 Host（对内一律 JSON）。
   */
  protected override async sendRequestInternal(request: UnknownObject): Promise<unknown> {
    const endpoint = this.getEffectiveEndpoint();
    const baseHeaders = await this.buildRequestHeaders();
    const headers = await this.finalizeRequestHeaders(baseHeaders, request);

    const context = this.createProviderContext();
    const entryEndpoint = this.extractEntryEndpoint(request) ?? this.extractEntryEndpoint(context);

    const submitPayload =
      typeof entryEndpoint === 'string' && entryEndpoint.trim().toLowerCase() === '/v1/responses.submit_tool_outputs'
        ? this.extractSubmitToolOutputsPayload(request)
        : null;
    if (submitPayload) {
      const submitEndpoint = this.buildSubmitToolOutputsEndpoint(endpoint, submitPayload.responseId);
      const submitTargetUrl = this.buildTargetUrl(this.getEffectiveBaseUrl(), submitEndpoint);
      return await this.sendSubmitToolOutputsRequest({
        endpoint: submitEndpoint,
        body: submitPayload.body,
        headers,
        context,
        targetUrl: submitTargetUrl,
        entryEndpoint,
        providerStream: this.extractStreamFlagFromBody(submitPayload.body),
        httpClient: this.httpClient
      });
    }

    const targetUrl = this.buildTargetUrl(this.getEffectiveBaseUrl(), endpoint);
    const finalBody = this.responsesClient.buildRequestBody(request);
    this.assertResponsesWireShape(finalBody);

    const explicitStream = this.extractStreamFlagFromBody(finalBody);
    const streamingPreference = this.responsesClient.getStreamingPreference();
    const useSse: boolean =
      streamingPreference === 'always'
        ? true
        : streamingPreference === 'never'
          ? false
          : explicitStream === true;

    const providerStream = explicitStream === true;
    this.responsesClient.ensureStreamFlag(finalBody, useSse);
    this.dependencies.logger?.logModule?.(this.id, 'responses-provider-stream-flag', {
      requestId: context.requestId,
      outboundStream: useSse,
      streamingPreference,
      explicitStream: explicitStream ?? null
    });

    await this.snapshotPhase('provider-request', context, finalBody, headers, targetUrl, entryEndpoint);

    try {
      if (useSse) {
        return await this.sendSseRequest({
          endpoint,
          body: finalBody,
          headers,
          context,
          targetUrl,
          entryEndpoint,
          providerStream,
          httpClient: this.httpClient
        });
      }

      return await this.sendJsonRequest({
        endpoint,
        body: finalBody,
        headers,
        context,
        targetUrl,
        entryEndpoint,
        httpClient: this.httpClient
      });
    } catch (error) {
      const normalizedError = this.normalizeUpstreamError(error);
      await this.snapshotPhase(
        'provider-error',
        context,
        {
          status: normalizedError.statusCode ?? normalizedError.status ?? null,
          code: normalizedError.code ?? null,
          error: normalizedError.message
        },
        headers,
        targetUrl,
        entryEndpoint
      );
      throw normalizedError;
    }
  }

  private assertResponsesWireShape(body: Record<string, unknown>): void {
    if (!body || typeof body !== 'object') {
      throw new Error('provider-runtime-error: responses payload must be an object');
    }
    if ('messages' in body && Array.isArray((body as any).messages)) {
      throw new Error(
        'provider-runtime-error: responses provider received chat-style "messages". ' +
        'This indicates a HubPipeline bypass; provider must receive Responses wire payload (input/instructions).'
      );
    }
    const hasInput = Array.isArray((body as any).input);
    const hasInstructions =
      typeof (body as any).instructions === 'string' && String((body as any).instructions).trim().length > 0;
    if (!hasInput && !hasInstructions) {
      throw new Error('provider-runtime-error: responses payload missing "input" or "instructions"');
    }
  }

  private buildTargetUrl(baseUrl: string, endpoint: string): string {
    const normalizedBase = baseUrl.replace(/\/$/, '');
    const normalizedEndpoint = endpoint.startsWith('/') ? endpoint.slice(1) : endpoint;
    return `${normalizedBase}/${normalizedEndpoint}`;
  }

  private extractStreamFlagFromBody(body: Record<string, unknown>): boolean | undefined {
    if (!body || typeof body !== 'object') {
      return undefined;
    }
    const direct = (body as Record<string, unknown>).stream;
    if (typeof direct === 'boolean') {
      return direct;
    }
    const parameters = (body as Record<string, unknown>).parameters;
    if (parameters && typeof parameters === 'object') {
      const nested = (parameters as Record<string, unknown>).stream;
      if (typeof nested === 'boolean') {
        return nested;
      }
    }
    return undefined;
  }

  private extractEntryEndpoint(source: unknown): string | undefined {
    if (!source || typeof source !== 'object') {
      return undefined;
    }
    const metadata = (source as { metadata?: unknown }).metadata;
    if (metadata && typeof metadata === 'object' && 'entryEndpoint' in metadata) {
      const value = (metadata as Record<string, unknown>).entryEndpoint;
      return typeof value === 'string' ? value : undefined;
    }
    return undefined;
  }

  private extractSubmitToolOutputsPayload(request: UnknownObject): SubmitToolOutputsPayload | null {
    if (!request || typeof request !== 'object') {
      return null;
    }
    const record = request as Record<string, unknown>;
    const rawId =
      typeof record.response_id === 'string'
        ? record.response_id
        : typeof record.responseId === 'string'
          ? record.responseId
          : undefined;
    const responseId = rawId && rawId.trim().length ? rawId.trim() : undefined;
    if (!responseId) {
      return null;
    }
    const toolOutputs = Array.isArray(record.tool_outputs) ? record.tool_outputs : null;
    if (!toolOutputs || !toolOutputs.length) {
      return null;
    }
    const submitBody = JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
    delete submitBody.response_id;
    delete submitBody.responseId;
    return {
      responseId,
      body: submitBody
    };
  }

  private buildSubmitToolOutputsEndpoint(baseEndpoint: string, responseId: string): string {
    const normalizedBase = baseEndpoint.replace(/\/+$/, '');
    const encodedId = encodeURIComponent(responseId);
    return `${normalizedBase}/${encodedId}/submit_tool_outputs`;
  }

  private async snapshotPhase(
    phase: 'provider-request' | 'provider-response' | 'provider-error',
    context: ProviderContext,
    data: unknown,
    headers: Record<string, string>,
    url: string,
    entryEndpoint?: string
  ): Promise<void> {
    try {
      const clientRequestId = this.extractClientRequestId(context);
      await writeProviderSnapshot({
        phase,
        requestId: context.requestId,
        data,
        headers,
        url,
        entryEndpoint,
        clientRequestId,
        providerKey: context.providerKey,
        providerId: context.providerId
      });
    } catch {
      // non-blocking
    }
  }

  private extractClientRequestId(context: ProviderContext): string | undefined {
    const metaValue = context.metadata && typeof context.metadata === 'object'
      ? (context.metadata as Record<string, unknown>).clientRequestId
      : undefined;
    if (typeof metaValue === 'string' && metaValue.trim().length) {
      return metaValue.trim();
    }
    const runtimeMeta = context.runtimeMetadata?.metadata;
    if (runtimeMeta && typeof runtimeMeta === 'object') {
      const candidate = (runtimeMeta as Record<string, unknown>).clientRequestId;
      if (typeof candidate === 'string' && candidate.trim().length) {
        return candidate.trim();
      }
    }
    return undefined;
  }

  private async sendSseRequest(options: {
    endpoint: string;
    body: Record<string, unknown>;
    headers: Record<string, string>;
    context: ProviderContext;
    targetUrl: string;
    entryEndpoint?: string;
    providerStream: boolean | undefined;
    httpClient: ResponsesHttpClient;
  }): Promise<unknown> {
    const { endpoint, body, headers, context, targetUrl, entryEndpoint, providerStream, httpClient } = options;
    const stream = await httpClient.postStream(endpoint, body, {
      ...headers,
      Accept: 'text/event-stream'
    });

    const captureSse = providerStream === true && shouldCaptureProviderStreamSnapshots();
    const streamForHost = captureSse
      ? attachProviderSseSnapshotStream(stream, {
        requestId: context.requestId,
        headers,
        url: targetUrl,
        entryEndpoint,
        clientRequestId: this.extractClientRequestId(context),
        providerKey: context.providerKey,
        providerId: context.providerId
      })
      : stream;

    const converter = await this.loadResponsesSseConverter();
    const json = await converter.convertSseToJson(streamForHost, {
      requestId: context.requestId,
      model: typeof body.model === 'string' ? body.model : 'unknown'
    });
    await this.snapshotPhase(
      'provider-response',
      context,
      {
        mode: 'sse',
        clientStream: providerStream === true,
        payload: json ?? null
      },
      headers,
      targetUrl,
      entryEndpoint
    );
    this.reportResponsesFailureIfNeeded(json, context);
    return {
      data: json,
      status: 200,
      statusText: 'OK',
      headers: {
        'x-upstream-mode': 'sse',
        'x-provider-stream-requested': providerStream === true ? '1' : '0'
      },
      url: targetUrl
    };
  }

  private async sendSubmitToolOutputsRequest(options: {
    endpoint: string;
    body: Record<string, unknown>;
    headers: Record<string, string>;
    context: ProviderContext;
    targetUrl: string;
    entryEndpoint?: string;
    providerStream: boolean | undefined;
    httpClient: ResponsesHttpClient;
  }): Promise<unknown> {
    const { endpoint, body, headers, context, targetUrl, entryEndpoint, providerStream, httpClient } = options;
    await this.snapshotPhase('provider-request', context, body, headers, targetUrl, entryEndpoint);
    try {
      const stream = await httpClient.postStream(endpoint, body, {
        ...headers,
        Accept: 'text/event-stream'
      });
      const captureSse = providerStream === true && shouldCaptureProviderStreamSnapshots();
      const streamForHost = captureSse
        ? attachProviderSseSnapshotStream(stream, {
          requestId: context.requestId,
          headers,
          url: targetUrl,
          entryEndpoint,
          clientRequestId: this.extractClientRequestId(context),
          providerKey: context.providerKey,
          providerId: context.providerId
        })
        : stream;
      const converter = await this.loadResponsesSseConverter();
      const json = await converter.convertSseToJson(streamForHost, {
        requestId: context.requestId,
        model: typeof context.model === 'string' ? context.model : 'unknown'
      });
      await this.snapshotPhase(
        'provider-response',
        context,
        {
          mode: 'sse',
          clientStream: providerStream === true,
          payload: json ?? null
        },
        headers,
        targetUrl,
        entryEndpoint
      );
      this.reportResponsesFailureIfNeeded(json, context);
      return {
        data: json,
        status: 200,
        statusText: 'OK',
        headers: {
          'x-upstream-mode': 'sse',
          'x-provider-stream-requested': providerStream === true ? '1' : '0'
        },
        url: targetUrl
      };
    } catch (error) {
      const normalizedError = this.normalizeUpstreamError(error);
      await this.snapshotPhase(
        'provider-error',
        context,
        {
          status: normalizedError.statusCode ?? normalizedError.status ?? null,
          code: normalizedError.code ?? null,
          error: normalizedError.message
        },
        headers,
        targetUrl,
        entryEndpoint
      );
      throw normalizedError;
    }
  }

  private async sendJsonRequest(options: {
    endpoint: string;
    body: Record<string, unknown>;
    headers: Record<string, string>;
    context: ProviderContext;
    targetUrl: string;
    entryEndpoint?: string;
    httpClient: ResponsesHttpClient;
  }): Promise<unknown> {
    const { endpoint, body, headers, context, targetUrl, entryEndpoint, httpClient } = options;
    const response = await httpClient.post(endpoint, body, {
      ...headers,
      Accept: 'application/json'
    });
    await this.snapshotPhase('provider-response', context, response, headers, targetUrl, entryEndpoint);
    this.reportResponsesFailureIfNeeded(response, context);
    return response;
  }

  private normalizeUpstreamError(error: unknown): Error & {
    status?: number;
    statusCode?: number;
    code?: string;
    response?: {
      data?: {
        error?: Record<string, unknown>;
      };
    };
  } {
    const normalized = error instanceof Error ? error : new Error(String(error ?? 'Unknown error'));
    const err = normalized as Error & {
      status?: number;
      statusCode?: number;
      code?: string;
      response?: {
        data?: {
          error?: Record<string, unknown>;
        };
      };
    };
    const message = typeof err.message === 'string' ? err.message : String(err || '');
    const match = message.match(/HTTP\s+(\d{3})/i);
    const existing = typeof err.statusCode === 'number' ? err.statusCode : typeof err.status === 'number' ? err.status : undefined;
    const statusCode = existing ?? (match ? Number(match[1]) : undefined);
    if (typeof statusCode === 'number' && !Number.isNaN(statusCode)) {
      err.statusCode = statusCode;
      err.status = statusCode;
      if (!err.code) {
        err.code = `HTTP_${statusCode}`;
      }
    }
    if (!err.response) {
      err.response = {};
    }
    if (!err.response.data) {
      err.response.data = {};
    }
    if (!err.response.data.error) {
      err.response.data.error = {};
    }
    if (err.code && !err.response.data.error.code) {
      err.response.data.error.code = err.code;
    }
    return err;
  }

  private async loadResponsesSseConverter(): Promise<ResponsesSseConverter> {
    return await createResponsesSseToJsonConverter();
  }

  private reportResponsesFailureIfNeeded(payload: unknown, context: ProviderContext): void {
    const failure = this.detectResponsesFailure(payload);
    if (!failure) {
      return;
    }
    const err = new Error(failure.message) as Error & { code?: string };
    err.code = failure.code ?? 'RESPONSES_FAILED';
    emitProviderError({
      error: err,
      stage: 'provider.responses',
      runtime: buildRuntimeFromProviderContext(context),
      dependencies: this.dependencies,
      statusCode: failure.statusCode,
      recoverable: failure.recoverable,
      details: {
        status: failure.status,
        code: failure.code,
        error: failure.rawError
      }
    });
  }

  private detectResponsesFailure(payload: unknown): ResponsesFailure | null {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return null;
    }
    const record = payload as Record<string, unknown>;
    const status = typeof record.status === 'string' ? record.status : undefined;
    const errorCandidate = record.error;
    const errorRecord = errorCandidate && typeof errorCandidate === 'object' && !Array.isArray(errorCandidate)
      ? (errorCandidate as Record<string, unknown>)
      : undefined;
    if (status !== 'failed' && !errorRecord) {
      return null;
    }
    const message = typeof errorRecord?.message === 'string'
      ? errorRecord.message
      : `Responses request failed${status ? ` (${status})` : ''}`;
    const code = typeof errorRecord?.code === 'string'
      ? errorRecord.code
      : status === 'failed'
        ? 'RESPONSES_FAILED'
        : undefined;
    const httpStatus = typeof errorRecord?.['http_status'] === 'number'
      ? (errorRecord['http_status'] as number)
      : undefined;
    const embeddedStatus = typeof errorRecord?.status === 'number'
      ? (errorRecord.status as number)
      : undefined;
    const statusCode = httpStatus ?? embeddedStatus ?? this.extractStatusFromErrorCode(code);
    const recoverable = this.isRecoverableStatus(statusCode, code);
    return {
      message,
      statusCode,
      code,
      recoverable,
      status,
      rawError: errorRecord
    };
  }

  private extractStatusFromErrorCode(code?: string): number | undefined {
    if (typeof code !== 'string') {
      return undefined;
    }
    const numericMatch = code.match(/(\d{3})/);
    if (numericMatch) {
      const candidate = Number(numericMatch[1] ?? numericMatch[0]);
      if (!Number.isNaN(candidate)) {
        return candidate;
      }
    }
    const lowered = code.toLowerCase();
    if (lowered.includes('quota') || lowered.includes('billing')) {
      return 402;
    }
    if (lowered.includes('unauthorized') || lowered.includes('auth')) {
      return 401;
    }
    if (lowered.includes('rate') || lowered.includes('limit')) {
      return 429;
    }
    return undefined;
  }

  private isRecoverableStatus(statusCode?: number, code?: string): boolean {
    if (statusCode === 429 || statusCode === 408) {
      return true;
    }
    if (!code) {
      return false;
    }
    const lowered = code.toLowerCase();
    return lowered.includes('rate') || lowered.includes('timeout') || lowered.includes('retry');
  }
}

function parseStreamingMode(value: unknown): ResponsesStreamingMode {
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase();
    if (lowered === 'always' || lowered === 'never') {
      return lowered;
    }
    if (lowered === 'auto') {
      return 'auto';
    }
  }
  return 'auto';
}

function extractResponsesConfig(config: UnknownObject): ResponsesProviderConfig {
  const container = isRecord(config) ? (config as Record<string, unknown>) : {};
  const providerConfig = isRecord(container.config)
    ? (container.config as Record<string, unknown>)
    : undefined;
  const responsesCfg = providerConfig && isRecord(providerConfig.responses)
      ? (providerConfig.responses as Record<string, unknown>)
      : isRecord(container.responses)
      ? (container.responses as Record<string, unknown>)
      : undefined;
  if (!responsesCfg) {
    return {};
  }
  return {
    streaming: 'streaming' in responsesCfg ? parseStreamingMode(responsesCfg.streaming) : undefined
  };
}

export default ResponsesProvider;
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

type ResponsesFailure = {
  message: string;
  status?: string;
  statusCode?: number;
  code?: string;
  recoverable: boolean;
  rawError?: Record<string, unknown>;
};
