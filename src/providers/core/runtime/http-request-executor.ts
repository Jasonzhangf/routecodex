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
  targetUrls?: string[];
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
  getBaseUrlCandidates?(context: ProviderContext): string[] | undefined;
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

type IflowBusinessErrorEnvelope = {
  code?: string;
  message: string;
};

function readIflowBusinessErrorEnvelope(data: unknown): IflowBusinessErrorEnvelope | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return null;
  }
  const record = data as Record<string, unknown>;
  const codeRaw = record.error_code ?? record.errorCode ?? record.code;
  const messageRaw =
    (typeof record.msg === 'string' && record.msg.trim().length
      ? record.msg
      : typeof record.message === 'string' && record.message.trim().length
        ? record.message
        : typeof record.error_message === 'string' && record.error_message.trim().length
          ? record.error_message
          : '') || '';

  const code =
    typeof codeRaw === 'string' && codeRaw.trim().length
      ? codeRaw.trim()
      : typeof codeRaw === 'number' && Number.isFinite(codeRaw)
        ? String(codeRaw)
        : '';

  const hasCode = code.length > 0 && code !== '0';
  const hasMessage = messageRaw.trim().length > 0;
  if (!hasCode && !hasMessage) {
    return null;
  }

  return {
    ...(hasCode ? { code } : {}),
    message: hasMessage ? messageRaw.trim() : 'iFlow upstream business error'
  };
}

function buildIflowBusinessEnvelopeError(
  envelope: IflowBusinessErrorEnvelope,
  data: Record<string, unknown>
): Error & {
  statusCode: number;
  status: number;
  code: string;
  response: { status: number; data: Record<string, unknown> };
} {
  const upstreamCode = envelope.code && envelope.code.trim().length ? envelope.code.trim() : 'iflow_business_error';
  const upstreamMessage = envelope.message;
  const errorMessage =
    'HTTP 400: iFlow business error (' + upstreamCode + ')' + (upstreamMessage ? ': ' + upstreamMessage : '');
  const error = new Error(errorMessage) as Error & {
    statusCode: number;
    status: number;
    code: string;
    response: { status: number; data: Record<string, unknown> };
  };

  error.statusCode = 400;
  error.status = 400;
  error.code = 'HTTP_400';
  error.response = {
    status: 400,
    data: {
      error: {
        code: upstreamCode,
        message: upstreamMessage
      },
      upstream: data
    }
  };
  return error;
}
export class HttpRequestExecutor {
  constructor(
    private readonly httpClient: HttpClient,
    private readonly deps: HttpRequestExecutorDeps
  ) { }

  async execute(processedRequest: UnknownObject, context: ProviderContext): Promise<unknown> {
    const prepared = await this.prepareHttpRequest(processedRequest, context);
    await this.snapshotProviderRequest(prepared, context);
    try {
      return await this.executeHttpRequestWithRetries(prepared, processedRequest, context);
    } catch (error) {
      const requestInfoOverride =
        error && typeof error === 'object' && '__routecodexRequestInfo' in error
          ? ((error as { __routecodexRequestInfo?: PreparedHttpRequest }).__routecodexRequestInfo ?? prepared)
          : prepared;
      const normalized = await this.deps.normalizeHttpError(error, processedRequest, requestInfoOverride, context);
      throw normalized;
    }
  }

  private async prepareHttpRequest(
    processedRequest: UnknownObject,
    context: ProviderContext
  ): Promise<PreparedHttpRequest> {
    const providerHint = String(
      (context as unknown as { providerKey?: unknown; providerId?: unknown; providerFamily?: unknown; providerType?: unknown })
        .providerKey ||
        (context as unknown as { providerId?: unknown }).providerId ||
        (context as unknown as { providerFamily?: unknown }).providerFamily ||
        (context as unknown as { providerType?: unknown }).providerType ||
        ''
    ).toLowerCase();
    const isAntigravity = providerHint.includes('antigravity');
    const wantsSse = this.deps.wantsUpstreamSse(processedRequest, context);
    const defaultEndpoint = this.deps.getEffectiveEndpoint();
    const endpoint = this.deps.resolveRequestEndpoint(processedRequest, defaultEndpoint);
    const headers = await this.deps.buildRequestHeaders();
    let finalHeaders = await this.deps.finalizeRequestHeaders(headers, processedRequest);
    finalHeaders = this.deps.applyStreamModeHeaders(finalHeaders, wantsSse);
    const baseUrlPrimary = this.deps.getEffectiveBaseUrl().replace(/\/$/, '');
    const endpointSuffix = endpoint.startsWith('/') ? endpoint.slice(1) : endpoint;
    const candidateBases = this.deps.getBaseUrlCandidates?.(context);
    const baseList =
      candidateBases && candidateBases.length
        ? (isAntigravity
            ? [
                ...candidateBases,
                // Keep configured primary as the last fallback for antigravity (Sandbox/Daily-first).
                ...(candidateBases.includes(baseUrlPrimary) ? [] : [baseUrlPrimary])
              ]
            : [baseUrlPrimary, ...candidateBases])
        : [baseUrlPrimary];
    const targets = Array.from(
      new Set(
        baseList
          .map((base) => String(base || '').trim())
          .filter((base) => base.length)
          .map((base) => base.replace(/\/$/, ''))
          .map((base) => `${base}/${endpointSuffix}`)
      )
    );
    const targetUrl = targets[0] || `${baseUrlPrimary}/${endpointSuffix}`;
    const targetUrls = targets.length > 1 ? targets : undefined;
    const finalBody = this.deps.buildHttpRequestBody(processedRequest);
    const meta = (context as { metadata?: unknown }).metadata;
    const metaEntryEndpoint =
      meta && typeof meta === 'object' && typeof (meta as Record<string, unknown>).entryEndpoint === 'string'
        ? ((meta as Record<string, unknown>).entryEndpoint as string)
        : undefined;
    const entryEndpoint =
      this.deps.getEntryEndpointFromPayload(processedRequest) ||
      metaEntryEndpoint;
    if (wantsSse) {
      this.deps.prepareSseRequestBody(finalBody, context);
    }
    const clientRequestId = this.deps.getClientRequestIdFromContext(context);
    await this.captureVisionDebugRequest(processedRequest, finalBody, {
      wantsSse,
      entryEndpoint,
      requestId: context.requestId,
      routeName: context.routeName,
      clientRequestId,
      providerKey: context.providerKey,
      providerId: context.providerId
    });

    const debugAntigravity = process.env.ROUTECODEX_DEBUG_ANTIGRAVITY === '1' || process.env.RCC_DEBUG_ANTIGRAVITY === '1';
    if (debugAntigravity) {
      try {
        await writeProviderSnapshot({
          phase: 'provider-preprocess-debug',
          requestId: context.requestId,
          data: {
            method: 'POST',
            endpoint,
            wantsSse,
            targetUrl,
            headers: finalHeaders,
            body: finalBody
          },
          headers: finalHeaders,
          url: targetUrl,
          entryEndpoint,
          clientRequestId,
          providerKey: context.providerKey,
          providerId: context.providerId
        });
      } catch {
        // ignore snapshot failures
      }
    }

    return {
      endpoint,
      headers: finalHeaders,
      targetUrl,
      targetUrls: targetUrls && targetUrls.length > 1 ? targetUrls : undefined,
      body: finalBody,
      entryEndpoint,
      clientRequestId,
      wantsSse
    };
  }

  private async captureVisionDebugRequest(
    processedRequest: UnknownObject,
    body: UnknownObject,
    options: {
      wantsSse: boolean;
      entryEndpoint?: string;
      requestId: string;
      routeName?: string;
      clientRequestId?: string;
      providerKey?: string;
      providerId?: string;
    }
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
        clientRequestId: options.clientRequestId ?? options.requestId,
        providerKey: options.providerKey,
        providerId: options.providerId
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
        clientRequestId: requestInfo.clientRequestId,
        providerKey: context.providerKey,
        providerId: context.providerId
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
    let lastRequestInfo: PreparedHttpRequest = requestInfo;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const targets =
        requestInfo.targetUrls && requestInfo.targetUrls.length ? requestInfo.targetUrls : [requestInfo.targetUrl];
      for (let idx = 0; idx < targets.length; idx += 1) {
        const candidate = idx === 0 ? requestInfo : { ...requestInfo, targetUrl: targets[idx] };
        lastRequestInfo = candidate;
        try {
          return await this.executeHttpRequestOnce(candidate, context, captureSse);
        } catch (error) {
          if (this.deps.tryRecoverOAuthAndReplay) {
            const oauthReplay = await this.deps.tryRecoverOAuthAndReplay(
              error,
              candidate,
              processedRequest,
              captureSse,
              context
            );
            if (oauthReplay) {
              return oauthReplay;
            }
          }

          const canTryNext = idx + 1 < targets.length && this.shouldTryNextTarget(error, context);
          if (canTryNext) {
            continue;
          }

          const shouldRetry = this.deps.shouldRetryHttpError(error, attempt, maxAttempts);
          if (shouldRetry) {
            await this.deps.delayBeforeHttpRetry(attempt);
            break;
          }

          if (error && typeof error === 'object') {
            (error as { __routecodexRequestInfo?: PreparedHttpRequest }).__routecodexRequestInfo = candidate;
          }
          throw error;
        }
      }
    }
    const finalError: Error & { __routecodexRequestInfo?: PreparedHttpRequest } = Object.assign(
      new Error('provider-runtime-error: http retries exhausted'),
      { __routecodexRequestInfo: lastRequestInfo }
    );
    throw finalError;
  }

  private shouldTryNextTarget(error: unknown, context: ProviderContext): boolean {
    const err = error as {
      statusCode?: unknown;
      status?: unknown;
      code?: unknown;
      type?: unknown;
      headers?: unknown;
      details?: unknown;
    };
    const statusCode =
      typeof err?.statusCode === 'number'
        ? err.statusCode
        : typeof err?.status === 'number'
          ? err.status
          : undefined;

    const ctx = context as unknown as {
      providerKey?: unknown;
      providerId?: unknown;
      providerFamily?: unknown;
      providerType?: unknown;
    };
    const providerHint = String(
      ctx.providerKey || ctx.providerId || ctx.providerFamily || ctx.providerType || ''
    ).toLowerCase();
    const isAntigravity = providerHint.includes('antigravity');

    // If upstream explicitly reports a context error, do NOT fallback to a different base.
    try {
      const headersFromTop =
        err && typeof err.headers === 'object' && err.headers !== null ? (err.headers as Record<string, unknown>) : undefined;
      const headersFromDetails = (() => {
        const details = err && typeof err.details === 'object' && err.details !== null ? (err.details as any) : undefined;
        const resp = details && typeof details.response === 'object' && details.response !== null ? details.response : undefined;
        const headers = resp && typeof resp.headers === 'object' && resp.headers !== null ? resp.headers : undefined;
        return headers as Record<string, unknown> | undefined;
      })();
      const headers = headersFromTop || headersFromDetails;
      const key = headers ? Object.keys(headers).find((k) => k.toLowerCase() === 'x-antigravity-context-error') : undefined;
      const value = key ? String(headers?.[key] ?? '').trim() : '';
      if (value) {
        return false;
      }
    } catch {
      // ignore
    }

    if (typeof err?.type === 'string' && err.type === 'network') {
      return true;
    }
    const code = typeof err?.code === 'string' ? err.code : '';
    if (code === 'UPSTREAM_HEADERS_TIMEOUT' || code === 'UPSTREAM_STREAM_TIMEOUT') {
      return true;
    }
    if (typeof statusCode === 'number') {
      // Antigravity: prefer switching baseUrl before switching alias on rate-limit or client-side errors.
      if (isAntigravity && statusCode === 429) return true;
      if (isAntigravity && statusCode === 400) return true;
      if (statusCode === 403) return true;
      if (statusCode === 404) return true;
      if (statusCode >= 500) return true;
    }
    return false;
  }

  private async executeHttpRequestOnce(
    requestInfo: PreparedHttpRequest,
    context: ProviderContext,
    captureSse: boolean
  ): Promise<unknown> {
    if (requestInfo.wantsSse) {
      const upstreamStream = await this.httpClient.postStream(requestInfo.targetUrl, requestInfo.body, requestInfo.headers);
      const streamForHost = captureSse
        ? attachProviderSseSnapshotStream(upstreamStream, {
          requestId: context.requestId,
          headers: requestInfo.headers,
          url: requestInfo.targetUrl,
          entryEndpoint: requestInfo.entryEndpoint,
          clientRequestId: requestInfo.clientRequestId,
          providerKey: context.providerKey,
          providerId: context.providerId
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
            clientRequestId: requestInfo.clientRequestId,
            providerKey: context.providerKey,
            providerId: context.providerId
          });
        } catch {
          /* ignore snapshot failures */
        }
      }
      return wrapped;
    }

    const response = await this.httpClient.post(requestInfo.targetUrl, requestInfo.body, requestInfo.headers);
    try {
      await writeProviderSnapshot({
        phase: 'provider-response',
        requestId: context.requestId,
        data: response,
        headers: requestInfo.headers,
        url: requestInfo.targetUrl,
        entryEndpoint: requestInfo.entryEndpoint,
        clientRequestId: requestInfo.clientRequestId,
        providerKey: context.providerKey,
        providerId: context.providerId
      });
    } catch {
      /* ignore snapshot failures */
    }

    // iFlow 特例：部分 OAuth 失效错误通过 HTTP 200 + body.status=439 返回，
    // 需要与 401/403 一样走统一的 OAuth 修复逻辑（handleUpstreamInvalidOAuthToken）。
    const providerId = (context as unknown as { providerId?: unknown; providerType?: unknown; providerFamily?: unknown })
      .providerId;
    const family = (context as unknown as { providerFamily?: unknown }).providerFamily;
    const pt = (typeof providerId === 'string' ? providerId : typeof family === 'string' ? family : '').toLowerCase();
    if (pt === 'iflow') {
      const data = (response as { data?: unknown }).data;
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        const bag = data as { status?: unknown; msg?: unknown; message?: unknown };
        const rawStatus = bag.status;
        const statusStr =
          typeof rawStatus === 'string' && rawStatus.trim().length
            ? rawStatus.trim()
            : typeof rawStatus === 'number'
              ? String(rawStatus)
              : '';
        const msg =
          (typeof bag.msg === 'string' && bag.msg.trim().length
            ? bag.msg
            : typeof bag.message === 'string' && bag.message.trim().length
              ? bag.message
              : '') || '';
        if (statusStr === '439' && /token has expired/i.test(msg)) {
          // 抛出 Error 交给上层的 tryRecoverOAuthAndReplay + handleUpstreamInvalidOAuthToken
          // 触发统一的 token 刷新 / Portal 授权流程。
          throw new Error(msg);
        }

        // iFlow 也可能返回 HTTP 200 + 业务错误包（如 { error_code, msg }）。
        // 这类响应不是 canonical provider payload，必须在 provider transport 层 fail-fast，
        // 避免流到 Hub 响应转换阶段才报 MALFORMED_RESPONSE。
        const envelope = readIflowBusinessErrorEnvelope(data);
        if (envelope) {
          throw buildIflowBusinessEnvelopeError(envelope, data as Record<string, unknown>);
        }
      }
    }
    return response;
  }
}
