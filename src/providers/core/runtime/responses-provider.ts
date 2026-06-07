/**
 * ResponsesProvider - 真实 OpenAI Responses SSE 透传 Provider
 *
 * 最小实现：继承 HttpTransportProvider，覆写 ServiceProfile 与发送路径，
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
  createResponsesSseToJsonConverter,
  sanitizeProviderOutboundPayload
} from '../../../modules/llmswitch/bridge.js';
import type { HttpClient } from '../utils/http-client.js';
import { ResponsesProtocolClient } from '../../../client/responses/responses-protocol-client.js';
import { extractProviderRuntimeMetadata } from './provider-runtime-metadata.js';
import { emitProviderError, buildRuntimeFromProviderContext } from '../utils/provider-error-reporter.js';
import {
  buildSubmitToolOutputsEndpoint,
  buildTargetUrl,
  detectResponsesFailure,
  extractClientRequestId,
  extractEntryEndpoint,
  extractResponsesDirectPassthroughFlag,
  extractResponsesConfig,
  extractStreamFlagFromBody,
  extractSubmitToolOutputsPayload,
  normalizeUpstreamError,
  type ResponsesProviderConfig,
  type ResponsesStreamingMode,
  type SubmitToolOutputsPayload
} from './responses-provider-helpers.js';

type ResponsesHttpClient = Pick<HttpClient, 'post' | 'postStream'>;
type ResponsesSseConverter = {
  convertSseToJson(stream: unknown, options: {
    requestId: string;
    model: string;
    noContentTimeoutMs?: number;
    contentIdleTimeoutMs?: number;
  }): Promise<unknown>;
};

// feature_id: responses.direct_tool_shape_contract

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
    if (extractResponsesDirectPassthroughFlag(request)) {
      return await this.processIncomingDirect(request);
    }

    const endpoint = this.getEffectiveEndpoint();
    const baseHeaders = await this.buildRequestHeaders();
    const headers = await this.finalizeRequestHeaders(baseHeaders, request);

    const context = this.createProviderContext();
    const entryEndpoint = extractEntryEndpoint(request) ?? extractEntryEndpoint(context);

    const submitPayload =
      typeof entryEndpoint === 'string' && entryEndpoint.trim().toLowerCase() === '/v1/responses.submit_tool_outputs'
        ? extractSubmitToolOutputsPayload(request)
        : null;
    if (submitPayload) {
      const submitEndpoint = buildSubmitToolOutputsEndpoint(endpoint, submitPayload.responseId);
      const submitTargetUrl = buildTargetUrl(this.getEffectiveBaseUrl(), submitEndpoint);
      return await this.sendSubmitToolOutputsRequest({
        endpoint: submitEndpoint,
        body: submitPayload.body,
        headers,
        context,
        targetUrl: submitTargetUrl,
        entryEndpoint,
        providerStream: extractStreamFlagFromBody(submitPayload.body),
        httpClient: this.httpClient
      });
    }

    const targetUrl = buildTargetUrl(this.getEffectiveBaseUrl(), endpoint);
    const builtBody = extractResponsesDirectPassthroughFlag(request)
      ? this.buildPassthroughResponsesBody(request)
      : this.responsesClient.buildRequestBody(request);
    const finalBody = await this.sanitizeResponsesProviderOutboundBody(builtBody, context);

    const explicitStream = extractStreamFlagFromBody(finalBody);
    const streamingPreference = this.responsesClient.getStreamingPreference();
    const useSse: boolean =
      explicitStream === false
        ? false
        : streamingPreference === 'always'
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
      const normalizedError = normalizeUpstreamError(error);
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

  async processIncomingDirect(request: UnknownObject): Promise<UnknownObject> {
    const directRequest = request as Record<string, unknown>;
    const endpoint = this.getEffectiveEndpoint();
    const baseHeaders = await this.buildRequestHeaders();
    const headers = await this.finalizeRequestHeaders(baseHeaders, directRequest);
    const context = this.createProviderContext();
    const entryEndpoint = extractEntryEndpoint(directRequest) ?? '/v1/responses';
    const targetUrl = buildTargetUrl(this.getEffectiveBaseUrl(), endpoint);
    const builtBody = this.buildPassthroughResponsesBody(directRequest);
    const finalBody = builtBody;
    const runtimeMetadata = extractProviderRuntimeMetadata(directRequest);
    const metadata = runtimeMetadata?.metadata && typeof runtimeMetadata.metadata === 'object' && !Array.isArray(runtimeMetadata.metadata)
      ? runtimeMetadata.metadata as Record<string, unknown>
      : undefined;
    const routeParams =
      metadata?.routeParams && typeof metadata.routeParams === 'object' && !Array.isArray(metadata.routeParams)
        ? (metadata.routeParams as Record<string, unknown>)
        : undefined;
    const routeModel = typeof routeParams?.model === 'string' ? routeParams.model.trim() : '';
    const defaultModel = typeof this.serviceProfile?.defaultModel === 'string'
      ? this.serviceProfile.defaultModel.trim()
      : '';
    const model = routeModel || defaultModel;
    if (model) {
      finalBody.model = model;
    }
    const overriddenBody = finalBody;
    const explicitStream = extractStreamFlagFromBody(overriddenBody);

    await this.snapshotPhase('provider-request', context, overriddenBody, headers, targetUrl, entryEndpoint);

    try {
      if (explicitStream === true) {
        return await this.sendDirectSsePassthroughRequest({
          body: overriddenBody,
          headers,
          context,
          targetUrl,
          entryEndpoint,
          httpClient: this.httpClient
        }) as UnknownObject;
      }

      return await this.sendJsonRequest({
        endpoint,
        body: overriddenBody,
        headers,
        context,
        targetUrl,
        entryEndpoint,
        httpClient: this.httpClient
      }) as UnknownObject;
    } catch (error) {
      const normalizedError = normalizeUpstreamError(error);
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

  /**
   * Direct mode SSE passthrough:
   * keep upstream SSE stream as-is for client bridge (no provider-side SSE->JSON conversion).
   */
  private async sendDirectSsePassthroughRequest(options: {
    body: Record<string, unknown>;
    headers: Record<string, string>;
    context: ProviderContext;
    targetUrl: string;
    entryEndpoint?: string;
    httpClient: ResponsesHttpClient;
  }): Promise<unknown> {
    const { body, headers, context, targetUrl, entryEndpoint, httpClient } = options;
    const stream = await httpClient.postStream(targetUrl, body, {
      ...headers,
      Accept: 'text/event-stream'
    });

    const streamForHost = shouldCaptureProviderStreamSnapshots()
      ? attachProviderSseSnapshotStream(stream, {
        requestId: context.requestId,
        headers,
        url: targetUrl,
        entryEndpoint,
        clientRequestId: extractClientRequestId(context),
        providerKey: context.providerKey,
        providerId: context.providerId
      })
      : stream;

    await this.snapshotPhase(
      'provider-response',
      context,
      {
        mode: 'sse_passthrough',
        clientStream: true
      },
      headers,
      targetUrl,
      entryEndpoint
    );

    return {
      __sse_responses: streamForHost,
      status: 200,
      statusText: 'OK',
      headers: {
        'x-upstream-mode': 'sse',
        'x-provider-stream-requested': '1'
      },
      url: targetUrl
    };
  }

  private buildPassthroughResponsesBody(request: UnknownObject): Record<string, unknown> {
    return request;
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
      const clientRequestId = extractClientRequestId(context);
      await writeProviderSnapshot({
        phase,
        requestId: context.requestId,
        data,
        headers,
        url,
        entryEndpoint,
        clientRequestId,
        providerKey: context.providerKey,
        providerId: context.providerId,
        metadata: context.metadata
      });
    } catch {
      // non-blocking
    }
  }

  /**
   * Shared SSE stream execution block.
   * Opens upstream SSE stream, converts to JSON, captures snapshots, reports failures.
   */
  private async executeSseStream(options: {
    body: Record<string, unknown>;
    headers: Record<string, string>;
    context: ProviderContext;
    targetUrl: string;
    entryEndpoint?: string;
    providerStream: boolean | undefined;
    httpClient: ResponsesHttpClient;
  }): Promise<unknown> {
    const { body, headers, context, targetUrl, entryEndpoint, providerStream, httpClient } = options;
    const stream = await httpClient.postStream(targetUrl, body, {
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
        clientRequestId: extractClientRequestId(context),
        providerKey: context.providerKey,
        providerId: context.providerId
      })
      : stream;

    const converter = await this.loadResponsesSseConverter();
    const json = await converter.convertSseToJson(streamForHost, {
      requestId: context.requestId,
      model: typeof body.model === 'string' ? body.model : 'unknown',
      noContentTimeoutMs: this.resolveNoContentTimeoutMs(context),
      contentIdleTimeoutMs: this.resolveContentIdleTimeoutMs(context)
    });
    if (!captureSse) {
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
    }
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
    return this.executeSseStream(options);
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
    const { context, headers, targetUrl, entryEndpoint } = options;
    const body = await this.sanitizeResponsesProviderOutboundBody(options.body, context);
    await this.snapshotPhase('provider-request', context, body, headers, targetUrl, entryEndpoint);
    try {
      return await this.executeSseStream({ ...options, body });
    } catch (error) {
      const normalizedError = normalizeUpstreamError(error);
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

  private resolveCompatibilityProfile(context: ProviderContext): string | undefined {
    const target = context.target && typeof context.target === 'object'
      ? context.target as Record<string, unknown>
      : undefined;
    const metadata = context.metadata && typeof context.metadata === 'object'
      ? context.metadata as Record<string, unknown>
      : undefined;
    const runtimeMetadata = context.runtimeMetadata && typeof context.runtimeMetadata === 'object'
      ? context.runtimeMetadata as Record<string, unknown>
      : undefined;
    for (const candidate of [
      target?.compatibilityProfile,
      metadata?.compatibilityProfile,
      runtimeMetadata?.compatibilityProfile,
      (this.config.config as { compatibilityProfile?: unknown }).compatibilityProfile,
    ]) {
      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate.trim().toLowerCase();
      }
    }
    return undefined;
  }

  private async sanitizeResponsesProviderOutboundBody(
    body: Record<string, unknown>,
    context: ProviderContext,
  ): Promise<Record<string, unknown>> {
    return await sanitizeProviderOutboundPayload({
      protocol: 'openai-responses',
      compatibilityProfile: this.resolveCompatibilityProfile(context),
      payload: body,
    });
  }

  private async loadResponsesSseConverter(): Promise<ResponsesSseConverter> {
    return await createResponsesSseToJsonConverter();
  }

  private resolveNoContentTimeoutMs(context: ProviderContext): number | undefined {
    const meta = context.metadata && typeof context.metadata === 'object'
      ? context.metadata as Record<string, unknown>
      : undefined;
    const candidate =
      meta?.providerStreamNoContentTimeoutMs
      ?? meta?.streamNoContentTimeoutMs
      ?? meta?.noContentTimeoutMs;
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) {
      return Math.floor(candidate);
    }
    const profileCandidate = context.profile?.extensions?.providerStreamNoContentTimeoutMs;
    if (typeof profileCandidate === 'number' && Number.isFinite(profileCandidate) && profileCandidate > 0) {
      return Math.floor(profileCandidate);
    }
    return 120_000;
  }

  private resolveContentIdleTimeoutMs(context: ProviderContext): number | undefined {
    const meta = context.metadata && typeof context.metadata === 'object'
      ? context.metadata as Record<string, unknown>
      : undefined;
    const candidate =
      meta?.providerStreamContentIdleTimeoutMs
      ?? meta?.streamContentIdleTimeoutMs
      ?? meta?.contentIdleTimeoutMs;
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) {
      return Math.floor(candidate);
    }
    const profileCandidate = context.profile?.extensions?.providerStreamContentIdleTimeoutMs;
    if (typeof profileCandidate === 'number' && Number.isFinite(profileCandidate) && profileCandidate > 0) {
      return Math.floor(profileCandidate);
    }
    return 300_000;
  }

  private reportResponsesFailureIfNeeded(payload: unknown, context: ProviderContext): void {
    const failure = detectResponsesFailure(payload);
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
      affectsHealth: failure.affectsHealth,
      details: {
        status: failure.status,
        code: failure.code,
        error: failure.rawError
      }
    });
  }
}

export default ResponsesProvider;
