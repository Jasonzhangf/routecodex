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
import { Readable } from 'node:stream';
import { sanitizeProviderOutboundPayload } from '../../../modules/llmswitch/bridge/native-exports.js';
import { readRuntimeRequestTruthPortNumber } from '../../../server/runtime/http-server/metadata-center/request-truth-readers.js';

const formatUnknownError = (error: unknown): string => {
  if (error instanceof Error) {
    return error.stack || `${error.name}: ${error.message}`;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
};

const logHttpRequestExecutorNonBlockingError = (
  stage: string,
  error: unknown,
  details?: Record<string, unknown>
): void => {
  try {
    const detailSuffix = details && Object.keys(details).length > 0 ? ` details=${JSON.stringify(details)}` : '';
    console.warn(
      `[http-request-executor] ${stage} failed (non-blocking): ${formatUnknownError(error)}${detailSuffix}`
    );
  } catch {
    // Never throw from non-blocking logging.
  }
};

const MAX_SSE_BUSINESS_ERROR_PEEK_BYTES = 64 * 1024;
const MAX_STREAM_JSON_PEEK_BYTES = 1024 * 1024;
const PROVIDER_REQUEST_INFO_LOCAL_MARKER = Symbol.for('routecodex.provider.requestInfo');

type ProviderRequestInfoLocalMarker = {
  [PROVIDER_REQUEST_INFO_LOCAL_MARKER]?: PreparedHttpRequest;
};

function readPreparedRequestFromLocalErrorMarker(error: unknown): PreparedHttpRequest | undefined {
  return error && typeof error === 'object'
    ? (error as ProviderRequestInfoLocalMarker)[PROVIDER_REQUEST_INFO_LOCAL_MARKER]
    : undefined;
}

function writePreparedRequestToLocalErrorMarker(error: unknown, requestInfo: PreparedHttpRequest): void {
  if (!error || typeof error !== 'object') {
    return;
  }
  (error as ProviderRequestInfoLocalMarker)[PROVIDER_REQUEST_INFO_LOCAL_MARKER] = requestInfo;
}

function readProviderSnapshotMetadata(context: ProviderContext): Record<string, unknown> | undefined {
  const metadata = (context as { metadata?: unknown }).metadata;
  const metadataRecord = metadata && typeof metadata === 'object'
    ? metadata as Record<string, unknown>
    : undefined;
  const runtimeMetadataRecord =
    context.runtimeMetadata?.metadata && typeof context.runtimeMetadata.metadata === 'object' && !Array.isArray(context.runtimeMetadata.metadata)
      ? context.runtimeMetadata.metadata as Record<string, unknown>
      : undefined;
  if (runtimeMetadataRecord && metadataRecord) {
    return {
      ...runtimeMetadataRecord,
      ...metadataRecord
    };
  }
  return runtimeMetadataRecord ?? metadataRecord;
}

function readProviderSnapshotEntryPort(context: ProviderContext): number | undefined {
  const readFromMetadata = (metadata: Record<string, unknown> | undefined): number | undefined => {
    if (!metadata) {
      return undefined;
    }
    return readRuntimeRequestTruthPortNumber(metadata);
  };
  const runtimeMetadataRecord =
    context.runtimeMetadata?.metadata && typeof context.runtimeMetadata.metadata === 'object' && !Array.isArray(context.runtimeMetadata.metadata)
      ? context.runtimeMetadata.metadata as Record<string, unknown>
      : undefined;
  return readFromMetadata(
    context.runtimeMetadata && typeof context.runtimeMetadata === 'object' ? context.runtimeMetadata as Record<string, unknown> : undefined
  ) ?? readFromMetadata(runtimeMetadataRecord) ?? readFromMetadata(readProviderSnapshotMetadata(context));
}

function parseFirstSseDataPayload(frame: string): UnknownObject | undefined {
  const dataLines = frame
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart());
  if (dataLines.length === 0) {
    return undefined;
  }
  const raw = dataLines.join('\n').trim();
  if (!raw || raw === '[DONE]') {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as UnknownObject)
      : undefined;
  } catch {
    return undefined;
  }
}

function startsWithJsonPayload(text: string): boolean {
  const trimmed = text.replace(/^\uFEFF/, '').trimStart();
  const first = trimmed.charAt(0);
  return first === '{' || first === '[';
}

async function splitJsonBodyFromReadableStream(
  stream: NodeJS.ReadableStream
): Promise<
  | { kind: 'json'; data: unknown }
  | { kind: 'stream'; stream: NodeJS.ReadableStream }
> {
  const asyncIterable = stream as unknown as AsyncIterable<Buffer | string | Uint8Array>;
  if (!asyncIterable || typeof asyncIterable[Symbol.asyncIterator] !== 'function') {
    return { kind: 'stream', stream };
  }

  const iterator = asyncIterable[Symbol.asyncIterator]();
  const buffered: Array<Buffer | string | Uint8Array> = [];
  const first = await iterator.next();
  if (first.done) {
    return { kind: 'stream', stream: Readable.from([]) };
  }
  buffered.push(first.value);
  const firstText = typeof first.value === 'string'
    ? first.value
    : Buffer.from(first.value).toString('utf8');
  if (!startsWithJsonPayload(firstText)) {
    async function* replay(): AsyncGenerator<Buffer | string | Uint8Array> {
      for (const chunk of buffered) {
        yield chunk;
      }
      while (true) {
        const next = await iterator.next();
        if (next.done) {
          return;
        }
        yield next.value;
      }
    }
    return { kind: 'stream', stream: Readable.from(replay()) };
  }

  let bufferedBytes = Buffer.byteLength(firstText, 'utf8');
  while (true) {
    const next = await iterator.next();
    if (next.done) {
      break;
    }
    buffered.push(next.value);
    bufferedBytes += Buffer.byteLength(
      typeof next.value === 'string' ? next.value : Buffer.from(next.value)
    );
    if (bufferedBytes > MAX_STREAM_JSON_PEEK_BYTES) {
      throw Object.assign(
        new Error('UPSTREAM_JSON_BODY_TOO_LARGE_FOR_STREAM_PROBE'),
        { code: 'UPSTREAM_JSON_BODY_TOO_LARGE_FOR_STREAM_PROBE', statusCode: 502, status: 502 }
      );
    }
  }

  const bodyText = buffered
    .map((chunk) => typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
    .join('');
  return { kind: 'json', data: JSON.parse(bodyText) };
}

async function detectProviderBusinessErrorBeforeStreaming(args: {
  stream: NodeJS.ReadableStream;
  context: ProviderContext;
  resolveBusinessResponseError?: (response: unknown, context: ProviderContext) => Error | undefined;
}): Promise<NodeJS.ReadableStream> {
  if (!args.resolveBusinessResponseError) {
    return args.stream;
  }
  const asyncIterable = args.stream as unknown as AsyncIterable<Buffer | string | Uint8Array>;
  if (!asyncIterable || typeof asyncIterable[Symbol.asyncIterator] !== 'function') {
    return args.stream;
  }
  const iterator = asyncIterable[Symbol.asyncIterator]();
  const buffered: Array<Buffer | string | Uint8Array> = [];
  let bufferedText = '';
  let inspected = false;

  while (!inspected && Buffer.byteLength(bufferedText, 'utf8') <= MAX_SSE_BUSINESS_ERROR_PEEK_BYTES) {
    const next = await iterator.next();
    if (next.done) {
      inspected = true;
      break;
    }
    const chunk = next.value;
    buffered.push(chunk);
    bufferedText += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    const frameEnd = bufferedText.indexOf('\n\n');
    if (frameEnd < 0) {
      continue;
    }
    inspected = true;
    const firstPayload = parseFirstSseDataPayload(bufferedText.slice(0, frameEnd));
    if (firstPayload) {
      const businessError = args.resolveBusinessResponseError(firstPayload, args.context);
      if (businessError) {
        throw businessError;
      }
    }
  }

  async function* replay(): AsyncGenerator<Buffer | string | Uint8Array> {
    for (const chunk of buffered) {
      yield chunk;
    }
    while (true) {
      const next = await iterator.next();
      if (next.done) {
        return;
      }
      yield next.value;
    }
  }

  return Readable.from(replay());
}

export type PreparedHttpRequest = {
  endpoint: string;
  headers: Record<string, string>;
  targetUrl: string;
  targetUrls?: string[];
  body: UnknownObject;
  entryEndpoint?: string;
  clientRequestId?: string;
  wantsSse: boolean;
  abortSignal?: AbortSignal;
};

export type PreparedRequestExecutor = (requestInfo: PreparedHttpRequest, context: ProviderContext, captureSse: boolean) => Promise<unknown>;

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
  executePreparedRequest?: PreparedRequestExecutor;
  resolveBusinessResponseError?(response: unknown, context: ProviderContext): Error | undefined;
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
  ) { }

  async execute(processedRequest: UnknownObject, context: ProviderContext): Promise<unknown> {
    const prepared = await this.prepareHttpRequest(processedRequest, context);
    try {
      return await this.executeHttpRequestAcrossTargets(processedRequest, context, prepared);
    } catch (error) {
      const requestInfoOverride =
        readPreparedRequestFromLocalErrorMarker(error) ?? prepared;
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
    void providerHint;
    const wantsSse = this.deps.wantsUpstreamSse(processedRequest, context);
    const defaultEndpoint = this.deps.getEffectiveEndpoint();
    const endpoint = this.deps.resolveRequestEndpoint(processedRequest, defaultEndpoint);
    const builtBody = this.deps.buildHttpRequestBody(processedRequest);
    const finalBody = await this.sanitizeProviderWireBody(builtBody, context);
    if (wantsSse) {
      this.deps.prepareSseRequestBody(finalBody, context);
    }
    const headers = await this.deps.buildRequestHeaders();
    let finalHeaders = await this.deps.finalizeRequestHeaders(headers, finalBody);
    finalHeaders = this.deps.applyStreamModeHeaders(finalHeaders, wantsSse);
    const baseUrlPrimary = this.deps.getEffectiveBaseUrl().replace(/\/$/, '');
    const endpointSuffix = endpoint.startsWith('/') ? endpoint.slice(1) : endpoint;
    const candidateBases = this.deps.getBaseUrlCandidates?.(context);
    const baseList =
      candidateBases && candidateBases.length
        ? [baseUrlPrimary, ...candidateBases]
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
    const meta = (context as { metadata?: unknown }).metadata;
    const metaEntryEndpoint =
      meta && typeof meta === 'object' && typeof (meta as Record<string, unknown>).entryEndpoint === 'string'
        ? ((meta as Record<string, unknown>).entryEndpoint as string)
        : undefined;
    const entryEndpoint =
      this.deps.getEntryEndpointFromPayload(processedRequest) ||
      metaEntryEndpoint;
    const clientRequestId = this.deps.getClientRequestIdFromContext(context);
    await this.captureVisionDebugRequest(processedRequest, finalBody, {
      wantsSse,
      entryEndpoint,
      requestId: context.requestId,
      routeName: context.routeName,
      clientRequestId,
      providerKey: context.providerKey,
      providerId: context.providerId,
      metadata: readProviderSnapshotMetadata(context)
    });


    return {
      endpoint,
      headers: finalHeaders,
      targetUrl,
      targetUrls: targetUrls && targetUrls.length > 1 ? targetUrls : undefined,
      body: finalBody,
      entryEndpoint,
      clientRequestId,
      wantsSse,
      ...(context.abortSignal ? { abortSignal: context.abortSignal } : {})
    };
  }

  private async sanitizeProviderWireBody(
    body: UnknownObject,
    context: ProviderContext,
  ): Promise<UnknownObject> {
    const providerProtocol = this.resolveProviderWireProtocol(context);
    if (!providerProtocol) {
      return body;
    }
    return await sanitizeProviderOutboundPayload({
      protocol: providerProtocol,
      compatibilityProfile: this.resolveCompatibilityProfile(context),
      payload: body,
    });
  }

  private resolveProviderWireProtocol(context: ProviderContext): string | undefined {
    const target = context.runtimeMetadata?.target ?? context.target;
    const outboundProfile = typeof target?.outboundProfile === 'string'
      ? target.outboundProfile.trim().toLowerCase()
      : '';
    if (outboundProfile) {
      if (outboundProfile === 'openai-chat' || outboundProfile === 'openai-responses' || outboundProfile === 'anthropic-messages' || outboundProfile === 'gemini-chat') {
        return outboundProfile;
      }
      if (outboundProfile === 'openai') return 'openai-chat';
      if (outboundProfile === 'responses') return 'openai-responses';
      if (outboundProfile === 'anthropic') return 'anthropic-messages';
      if (outboundProfile === 'gemini') return 'gemini-chat';
    }
    if (context.providerType === 'openai') return 'openai-chat';
    if (context.providerType === 'responses') return 'openai-responses';
    if (context.providerType === 'anthropic') return 'anthropic-messages';
    if (context.providerType === 'gemini') return 'gemini-chat';
    return undefined;
  }

  private resolveCompatibilityProfile(context: ProviderContext): string | undefined {
    const values = [
      context.runtimeMetadata?.target?.compatibilityProfile,
      context.target?.compatibilityProfile,
      context.runtimeMetadata?.compatibilityProfile,
      context.metadata?.compatibilityProfile,
    ];
    for (const value of values) {
      if (typeof value === 'string' && value.trim()) {
        return value.trim().toLowerCase();
      }
    }
    return undefined;
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
      metadata?: Record<string, unknown>;
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
      const entryPort = readProviderSnapshotEntryPort({ metadata: options.metadata } as ProviderContext);
      await writeProviderSnapshot({
        phase: 'provider-body-debug',
        requestId,
        data: buildVisionSnapshotPayload(body, {
          wantsSse: options.wantsSse
        }),
        entryEndpoint: options.entryEndpoint,
        entryPort,
        clientRequestId: options.clientRequestId ?? options.requestId,
        providerKey: options.providerKey,
        providerId: options.providerId,
        metadata: options.metadata
      });
    } catch (snapshotError) {
      logHttpRequestExecutorNonBlockingError('captureVisionDebugRequest.provider-body-debug', snapshotError, {
        requestId,
        providerKey: options.providerKey,
        providerId: options.providerId
      });
    }
    try {
      const summary = summarizeVisionMessages(body);
      console.debug(
        `[vision-debug][build-body] route=${debug.routeName ?? options.routeName ?? 'vision'} ` +
        `request=${requestId} wantsSse=${options.wantsSse} ${summary}`
      );
    } catch (logError) {
      logHttpRequestExecutorNonBlockingError('captureVisionDebugRequest.summarizeVisionMessages', logError, {
        requestId
      });
    }
  }

  private async executeHttpRequestAcrossTargets(
    processedRequest: UnknownObject,
    context: ProviderContext,
    initialRequestInfo: PreparedHttpRequest
  ): Promise<unknown> {
    const captureSse = shouldCaptureProviderStreamSnapshots();
    let lastRequestInfo: PreparedHttpRequest = initialRequestInfo;
    if (initialRequestInfo.abortSignal?.aborted) {
      const reason = (initialRequestInfo.abortSignal as { reason?: unknown }).reason;
      throw reason instanceof Error
        ? reason
        : Object.assign(new Error(String(reason ?? 'CLIENT_DISCONNECTED')), {
            code: 'CLIENT_DISCONNECTED',
            name: 'AbortError'
          });
    }
    const targets =
      initialRequestInfo.targetUrls && initialRequestInfo.targetUrls.length ? initialRequestInfo.targetUrls : [initialRequestInfo.targetUrl];
    for (let idx = 0; idx < targets.length; idx += 1) {
      const candidate = idx === 0 ? initialRequestInfo : { ...initialRequestInfo, targetUrl: targets[idx] };
      lastRequestInfo = candidate;
      try {
        return await this.executeHttpRequestOnce(candidate, context, captureSse);
      } catch (error) {
        const canTryNext = idx + 1 < targets.length && this.shouldTryNextTarget(error, context);
        if (canTryNext) {
          continue;
        }

        if (error && typeof error === 'object') {
          writePreparedRequestToLocalErrorMarker(error, candidate);
        }
        throw error;
      }
    }
    const finalError: Error = Object.assign(
      new Error('provider-runtime-error: no provider HTTP target executed'),
    );
    writePreparedRequestToLocalErrorMarker(finalError, lastRequestInfo);
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
    void providerHint;

    if (typeof err?.type === 'string' && err.type === 'network') {
      return true;
    }
    const code = typeof err?.code === 'string' ? err.code : '';
    if (
      code === 'UPSTREAM_HEADERS_TIMEOUT'
      || code === 'UPSTREAM_STREAM_TIMEOUT'
      || code === 'UPSTREAM_STREAM_IDLE_TIMEOUT'
      || code === 'UPSTREAM_STREAM_NO_CONTENT_TIMEOUT'
      || code === 'UPSTREAM_STREAM_CONTENT_IDLE_TIMEOUT'
    ) {
      return true;
    }
    if (typeof statusCode === 'number') {
      if (statusCode === 403) return true;
      if (statusCode >= 500) return true;
    }
    return false;
  }

  private async executeHttpRequestOnce(
    requestInfo: PreparedHttpRequest,
    context: ProviderContext,
    captureSse: boolean
  ): Promise<unknown> {
    try {
      const entryPort = readProviderSnapshotEntryPort(context);
      await writeProviderSnapshot({
        phase: 'provider-request',
        requestId: context.requestId,
        data: requestInfo.body,
        headers: requestInfo.headers,
        url: requestInfo.targetUrl,
        entryEndpoint: requestInfo.entryEndpoint,
        entryPort,
        clientRequestId: requestInfo.clientRequestId,
        providerKey: context.providerKey,
        providerId: context.providerId,
        metadata: readProviderSnapshotMetadata(context)
      });
    } catch (snapshotError) {
      logHttpRequestExecutorNonBlockingError('executeHttpRequestOnce.provider-request', snapshotError, {
        requestId: context.requestId,
        providerKey: context.providerKey,
        providerId: context.providerId
      });
    }
    const response = this.deps.executePreparedRequest
      ? await this.deps.executePreparedRequest(requestInfo, context, captureSse)
      : requestInfo.wantsSse
        ? await (async () => {
            const entryPort = readProviderSnapshotEntryPort(context);
            const upstreamResult = typeof this.httpClient.postStreamOrResponse === 'function'
              ? await this.httpClient.postStreamOrResponse(
                  requestInfo.targetUrl,
                  requestInfo.body,
                  requestInfo.headers,
                  undefined,
                  requestInfo.abortSignal
                )
              : {
                  kind: 'stream' as const,
                  stream: await this.httpClient.postStream(
                    requestInfo.targetUrl,
                    requestInfo.body,
                    requestInfo.headers,
                    undefined,
                    requestInfo.abortSignal
                  )
                };
            if (upstreamResult.kind === 'response') {
              return upstreamResult.response;
            }
            const upstreamStream = upstreamResult.stream;
            const businessCheckedStream = await detectProviderBusinessErrorBeforeStreaming({
              stream: upstreamStream,
              context,
              resolveBusinessResponseError: this.deps.resolveBusinessResponseError
            });
            const streamForHost = captureSse
              ? attachProviderSseSnapshotStream(businessCheckedStream, {
                  requestId: context.requestId,
                  headers: requestInfo.headers,
                  url: requestInfo.targetUrl,
                  entryEndpoint: requestInfo.entryEndpoint,
                  entryPort,
                  clientRequestId: requestInfo.clientRequestId,
                  providerKey: context.providerKey,
                  providerId: context.providerId,
                  metadata: readProviderSnapshotMetadata(context)
                })
              : businessCheckedStream;
            const wrapped = await this.deps.wrapUpstreamSseResponse(streamForHost, context);
            try {
              await writeProviderSnapshot({
                phase: 'provider-response',
                requestId: context.requestId,
                data: {
                  mode: 'sse',
                  captureSse,
                  transport: 'upstream-stream'
                },
                headers: requestInfo.headers,
                url: requestInfo.targetUrl,
                entryEndpoint: requestInfo.entryEndpoint,
                entryPort,
                clientRequestId: requestInfo.clientRequestId,
                providerKey: context.providerKey,
                providerId: context.providerId,
                metadata: readProviderSnapshotMetadata(context)
              });
            } catch (snapshotError) {
              logHttpRequestExecutorNonBlockingError('executeHttpRequestOnce.provider-response.sse', snapshotError, {
                requestId: context.requestId,
                providerKey: context.providerKey,
                providerId: context.providerId
              });
            }
            return wrapped;
          })()
        : await this.httpClient.post(
            requestInfo.targetUrl,
            requestInfo.body,
            requestInfo.headers,
            requestInfo.abortSignal
          );

    if (requestInfo.wantsSse) {
      if (!this.deps.executePreparedRequest) {
        return response;
      }
      const entryPort = readProviderSnapshotEntryPort(context);
      const responseRecord = response && typeof response === 'object' ? (response as Record<string, unknown>) : undefined;
      const sseStream = responseRecord?.sseStream;
      if (sseStream && typeof (sseStream as NodeJS.ReadableStream).pipe === 'function') {
        const upstreamStream = sseStream as NodeJS.ReadableStream;
        const probedPreparedBody = await splitJsonBodyFromReadableStream(upstreamStream);
        if (probedPreparedBody.kind === 'json') {
          const jsonResponse = {
            ...responseRecord,
            data: probedPreparedBody.data,
            status:
              typeof responseRecord?.status === 'number'
                ? responseRecord.status
                : 200,
            statusText:
              typeof responseRecord?.statusText === 'string' && responseRecord.statusText.trim()
                ? responseRecord.statusText
                : 'OK',
            headers:
              responseRecord?.headers && typeof responseRecord.headers === 'object'
                ? responseRecord.headers
                : {}
          };
          try {
            await writeProviderSnapshot({
              phase: 'provider-response',
              requestId: context.requestId,
              data: jsonResponse,
              headers: requestInfo.headers,
              url: requestInfo.targetUrl,
              entryEndpoint: requestInfo.entryEndpoint,
              entryPort,
              clientRequestId: requestInfo.clientRequestId,
              providerKey: context.providerKey,
              providerId: context.providerId,
              metadata: readProviderSnapshotMetadata(context)
            });
          } catch (snapshotError) {
            logHttpRequestExecutorNonBlockingError('executeHttpRequestOnce.provider-response.json.prepared', snapshotError, {
              requestId: context.requestId,
              providerKey: context.providerKey,
              providerId: context.providerId
            });
          }
          const profileBusinessError = this.deps.resolveBusinessResponseError?.(jsonResponse, context);
          if (profileBusinessError) {
            throw profileBusinessError;
          }
          return jsonResponse;
        }
        const businessCheckedStream = await detectProviderBusinessErrorBeforeStreaming({
          stream: probedPreparedBody.stream,
          context,
          resolveBusinessResponseError: this.deps.resolveBusinessResponseError
        });
        const streamForHost = captureSse
          ? attachProviderSseSnapshotStream(businessCheckedStream, {
              requestId: context.requestId,
              headers: requestInfo.headers,
              url: requestInfo.targetUrl,
              entryEndpoint: requestInfo.entryEndpoint,
              entryPort,
              clientRequestId: requestInfo.clientRequestId,
              providerKey: context.providerKey,
              providerId: context.providerId,
              metadata: readProviderSnapshotMetadata(context)
            })
          : businessCheckedStream;
        const wrapped = await this.deps.wrapUpstreamSseResponse(streamForHost, context);
        try {
          await writeProviderSnapshot({
            phase: 'provider-response',
            requestId: context.requestId,
            data: {
              mode: 'sse',
              captureSse,
              transport: 'prepared-request-executor'
            },
            headers: requestInfo.headers,
            url: requestInfo.targetUrl,
            entryEndpoint: requestInfo.entryEndpoint,
            entryPort,
            clientRequestId: requestInfo.clientRequestId,
            providerKey: context.providerKey,
            providerId: context.providerId,
            metadata: readProviderSnapshotMetadata(context)
          });
        } catch (snapshotError) {
          logHttpRequestExecutorNonBlockingError('executeHttpRequestOnce.provider-response.sse.prepared', snapshotError, {
            requestId: context.requestId,
            providerKey: context.providerKey,
            providerId: context.providerId
          });
        }
        if (wrapped && typeof wrapped === 'object') {
          return {
            ...responseRecord,
            ...(wrapped as Record<string, unknown>)
          };
        }
        return wrapped;
      }
      return response;
    }

    try {
      const entryPort = readProviderSnapshotEntryPort(context);
      await writeProviderSnapshot({
        phase: 'provider-response',
        requestId: context.requestId,
        data: response,
        headers: requestInfo.headers,
        url: requestInfo.targetUrl,
        entryEndpoint: requestInfo.entryEndpoint,
        entryPort,
        clientRequestId: requestInfo.clientRequestId,
        providerKey: context.providerKey,
        providerId: context.providerId,
        metadata: readProviderSnapshotMetadata(context)
      });
    } catch (snapshotError) {
      logHttpRequestExecutorNonBlockingError('executeHttpRequestOnce.provider-response', snapshotError, {
        requestId: context.requestId,
        providerKey: context.providerKey,
        providerId: context.providerId
      });
    }
    const profileBusinessError = this.deps.resolveBusinessResponseError?.(response, context);
    if (profileBusinessError) {
      throw profileBusinessError;
    }

    return response;
  }
}
