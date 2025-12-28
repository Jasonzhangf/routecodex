import {
  attachProviderSseSnapshotStream,
  shouldCaptureProviderStreamSnapshots,
  writeProviderSnapshot
} from '../utils/snapshot-writer.js';
import type { HttpClient } from '../utils/http-client.js';
import type { UnknownObject } from '../../../types/common-types.js';
import type { ProviderContext } from '../api/provider-types.js';
import {
  buildVisionSnapshotPayload,
  shouldCaptureVisionDebug,
  summarizeVisionMessages
} from './vision-debug-utils.js';
import type { ProviderErrorAugmented } from './provider-error-types.js';

export type PreparedHttpRequest = {
  endpoint: string;
  headers: Record<string, string>;
  targetUrl: string;
  body: UnknownObject;
  entryEndpoint?: string;
  clientRequestId?: string;
  wantsSse: boolean;
};

export type HttpRequestExecutorDeps = {
  wantsUpstreamSse(request: UnknownObject, context: ProviderContext): boolean;
  getEffectiveEndpoint(): string;
  resolveRequestEndpoint(request: UnknownObject, defaultEndpoint: string): string;
  buildRequestHeaders(): Promise<Record<string, string>>;
  finalizeRequestHeaders(headers: Record<string, string>, request: UnknownObject): Promise<Record<string, string>>;
  applyStreamModeHeaders(headers: Record<string, string>, wantsSse: boolean): Record<string, string>;
  getEffectiveBaseUrl(): string;
  buildHttpRequestBody(request: UnknownObject): UnknownObject;
  prepareSseRequestBody(body: UnknownObject, context: ProviderContext): void;
  getEntryEndpointFromPayload(request: UnknownObject): string | undefined;
  getClientRequestIdFromContext(context: ProviderContext): string | undefined;
  wrapUpstreamSseResponse(stream: NodeJS.ReadableStream, context: ProviderContext): Promise<UnknownObject>;
  getHttpRetryLimit(): number;
  shouldRetryHttpError(error: unknown, attempt: number, maxAttempts: number): boolean;
  delayBeforeHttpRetry(attempt: number): Promise<void>;
  tryRecoverOAuthAndReplay?(
    error: unknown,
    requestInfo: PreparedHttpRequest,
    processedRequest: UnknownObject,
    captureSse: boolean,
    context: ProviderContext
  ): Promise<unknown | undefined>;
  normalizeHttpError(
    error: unknown,
    processedRequest: UnknownObject,
    requestInfo: PreparedHttpRequest,
    context: ProviderContext
  ): Promise<ProviderErrorAugmented>;
};

export class HttpRequestExecutor {
  constructor(
    private readonly httpClient: HttpClient,
    private readonly deps: HttpRequestExecutorDeps
  ) {}

  async execute(processedRequest: UnknownObject, context: ProviderContext): Promise<unknown> {
    const prepared = await this.prepareHttpRequest(processedRequest, context);
    await this.snapshotProviderRequest(prepared, context);
    try {
      return await this.executeHttpRequestWithRetries(prepared, processedRequest, context);
    } catch (error) {
      const normalized = await this.deps.normalizeHttpError(error, processedRequest, prepared, context);
      throw normalized;
    }
  }

  private async prepareHttpRequest(
    processedRequest: UnknownObject,
    context: ProviderContext
  ): Promise<PreparedHttpRequest> {
    const wantsSse = this.deps.wantsUpstreamSse(processedRequest, context);
    const defaultEndpoint = this.deps.getEffectiveEndpoint();
    const endpoint = this.deps.resolveRequestEndpoint(processedRequest, defaultEndpoint);
    const headers = await this.deps.buildRequestHeaders();
    let finalHeaders = await this.deps.finalizeRequestHeaders(headers, processedRequest);
    finalHeaders = this.deps.applyStreamModeHeaders(finalHeaders, wantsSse);
    const targetUrl = `${this.deps.getEffectiveBaseUrl().replace(/\/$/, '')}/${endpoint.startsWith('/') ? endpoint.slice(1) : endpoint}`;
    const finalBody = this.deps.buildHttpRequestBody(processedRequest);
    const entryEndpoint = this.deps.getEntryEndpointFromPayload(processedRequest);
    if (wantsSse) {
      this.deps.prepareSseRequestBody(finalBody, context);
    }
    const clientRequestId = this.deps.getClientRequestIdFromContext(context);
    await this.captureVisionDebugRequest(processedRequest, finalBody, {
      wantsSse,
      entryEndpoint,
      requestId: context.requestId,
      routeName: context.routeName,
      clientRequestId
    });
    return {
      endpoint,
      headers: finalHeaders,
      targetUrl,
      body: finalBody,
      entryEndpoint,
      clientRequestId,
      wantsSse
    };
  }

  private async captureVisionDebugRequest(
    processedRequest: UnknownObject,
    body: UnknownObject,
    options: { wantsSse: boolean; entryEndpoint?: string; requestId: string; routeName?: string; clientRequestId?: string }
  ): Promise<void> {
    const debug = shouldCaptureVisionDebug(processedRequest, {
      routeName: options.routeName,
      requestId: options.requestId
    });
    if (!debug.enabled) {
      return;
    }
    const requestId = debug.requestId ?? options.requestId;
    try {
      await writeProviderSnapshot({
        phase: 'provider-body-debug',
        requestId,
        data: buildVisionSnapshotPayload(body, {
          wantsSse: options.wantsSse
        }),
        entryEndpoint: options.entryEndpoint,
        clientRequestId: options.clientRequestId ?? options.requestId
      });
    } catch {
      // ignore snapshot failures
    }
    try {
      const summary = summarizeVisionMessages(body);
      console.debug(
        `[vision-debug][build-body] route=${debug.routeName ?? options.routeName ?? 'vision'} ` +
        `request=${requestId} wantsSse=${options.wantsSse} ${summary}`
      );
    } catch {
      // best-effort logging
    }
  }

  private async snapshotProviderRequest(requestInfo: PreparedHttpRequest, context: ProviderContext): Promise<void> {
    try {
      await writeProviderSnapshot({
        phase: 'provider-request',
        requestId: context.requestId,
        data: requestInfo.body,
        headers: requestInfo.headers,
        url: requestInfo.targetUrl,
        entryEndpoint: requestInfo.entryEndpoint,
        clientRequestId: requestInfo.clientRequestId
      });
    } catch {
      /* ignore snapshot failures */
    }
  }

  private async executeHttpRequestWithRetries(
    requestInfo: PreparedHttpRequest,
    processedRequest: UnknownObject,
    context: ProviderContext
  ): Promise<unknown> {
    const captureSse = shouldCaptureProviderStreamSnapshots();
    const maxAttempts = this.deps.getHttpRetryLimit();
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.executeHttpRequestOnce(requestInfo, context, captureSse);
      } catch (error) {
        if (this.deps.tryRecoverOAuthAndReplay) {
          const oauthReplay = await this.deps.tryRecoverOAuthAndReplay(
            error,
            requestInfo,
            processedRequest,
            captureSse,
            context
          );
          if (oauthReplay) {
            return oauthReplay;
          }
        }

        const shouldRetry = this.deps.shouldRetryHttpError(error, attempt, maxAttempts);
        if (shouldRetry) {
          await this.deps.delayBeforeHttpRetry(attempt);
          continue;
        }

        throw error;
      }
    }
    throw new Error('provider-runtime-error: http retries exhausted');
  }

  private async executeHttpRequestOnce(
    requestInfo: PreparedHttpRequest,
    context: ProviderContext,
    captureSse: boolean
  ): Promise<unknown> {
    if (requestInfo.wantsSse) {
      const upstreamStream = await this.httpClient.postStream(requestInfo.endpoint, requestInfo.body, requestInfo.headers);
      const streamForHost = captureSse
        ? attachProviderSseSnapshotStream(upstreamStream, {
          requestId: context.requestId,
          headers: requestInfo.headers,
          url: requestInfo.targetUrl,
          entryEndpoint: requestInfo.entryEndpoint,
          clientRequestId: requestInfo.clientRequestId
        })
        : upstreamStream;
      const wrapped = await this.deps.wrapUpstreamSseResponse(streamForHost, context);
      if (!captureSse) {
        try {
          await writeProviderSnapshot({
            phase: 'provider-response',
            requestId: context.requestId,
            data: { mode: 'sse' },
            headers: requestInfo.headers,
            url: requestInfo.targetUrl,
            entryEndpoint: requestInfo.entryEndpoint,
            clientRequestId: requestInfo.clientRequestId
          });
        } catch {
          /* ignore snapshot failures */
        }
      }
      return wrapped;
    }

    const response = await this.httpClient.post(requestInfo.endpoint, requestInfo.body, requestInfo.headers);
    try {
      await writeProviderSnapshot({
        phase: 'provider-response',
        requestId: context.requestId,
        data: response,
        headers: requestInfo.headers,
        url: requestInfo.targetUrl,
        entryEndpoint: requestInfo.entryEndpoint,
        clientRequestId: requestInfo.clientRequestId
      });
    } catch {
      /* ignore snapshot failures */
    }
    return response;
  }
}
