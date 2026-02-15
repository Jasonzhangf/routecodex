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
import {
  buildSubmitToolOutputsEndpoint,
  buildTargetUrl,
  detectResponsesFailure,
  extractClientRequestId,
  extractEntryEndpoint,
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
  convertSseToJson(stream: unknown, options: { requestId: string; model: string }): Promise<unknown>;
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
    const finalBody = this.responsesClient.buildRequestBody(request);
    this.assertResponsesWireShape(finalBody);

    const explicitStream = extractStreamFlagFromBody(finalBody);
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
        providerId: context.providerId
      });
    } catch {
      // non-blocking
    }
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
        clientRequestId: extractClientRequestId(context),
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
          clientRequestId: extractClientRequestId(context),
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

  private async loadResponsesSseConverter(): Promise<ResponsesSseConverter> {
    return await createResponsesSseToJsonConverter();
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
      details: {
        status: failure.status,
        code: failure.code,
        error: failure.rawError
      }
    });
  }
}

export default ResponsesProvider;
