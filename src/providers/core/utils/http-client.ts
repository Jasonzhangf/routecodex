/**
 * HTTP Client - 统一HTTP客户端
 *
 * 提供统一的HTTP请求处理功能
 */

import type {
  ReadableStream as WebReadableStream,
  ReadableStreamDefaultReader
} from 'node:stream/web';
import { Readable } from 'node:stream';
import type { ProviderError } from '../api/provider-types.js';
import { DEFAULT_PROVIDER, DEFAULT_TIMEOUTS } from '../../../constants/index.js';

/**
 * HTTP请求配置
 */
export interface HttpRequestConfig {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  headers?: Record<string, string>;
  timeout?: number;
  maxRetries?: number;
  retryDelay?: number;
  signal?: AbortSignal;
}

/**
 * HTTP响应
 */
export interface HttpResponse {
  data: unknown;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  url: string;
}

export type HttpStreamOrResponse =
  | {
      kind: 'stream';
      stream: NodeJS.ReadableStream;
      status: number;
      statusText: string;
      headers: Record<string, string>;
      url: string;
    }
  | {
      kind: 'response';
      response: HttpResponse;
      responseKind: 'json' | 'text';
    };

/**
 * HTTP客户端配置
 */
export interface HttpClientConfig {
  baseUrl?: string;
  timeout?: number;
  maxRetries?: number;
  retryDelay?: number;
  defaultHeaders?: Record<string, string>;
  /**
   * Stream idle timeout (ms) after response headers are received.
   * When upstream stream produces no bytes for this long, abort.
   */
  streamIdleTimeoutMs?: number;
  /**
   * Stream headers timeout (ms) before the initial response headers are received.
   */
  streamHeadersTimeoutMs?: number;
}

/**
 * 统一HTTP客户端
 *
 * 提供标准的HTTP请求处理，支持重试、超时等特性
 */
type ErrorResponsePayload = {
  data?: unknown;
  raw?: string;
};

type UpstreamError = Error & {
  status?: number;
  statusCode?: number;
  code?: string;
  response?: ErrorResponsePayload;
  retryable?: boolean;
  headers?: Record<string, string>;
};

type Uint8ReadableStream = WebReadableStream<Uint8Array>;
type Uint8ReadableStreamReader = ReadableStreamDefaultReader<Uint8Array>;

type StreamBody = Uint8ReadableStream | NodeJS.ReadableStream | null;

const isNodeReadable = (value: unknown): value is NodeJS.ReadableStream => {
  return Boolean(value && typeof (value as NodeJS.ReadableStream).pipe === 'function');
};

const isWebReadableStream = (
  value: unknown
): value is Uint8ReadableStream => {
  return Boolean(value && typeof (value as Uint8ReadableStream).getReader === 'function');
};

const peekReadableStream = async (
  stream: Uint8ReadableStream
): Promise<string> => {
  const reader: Uint8ReadableStreamReader = stream.getReader();
  try {
    const { value } = await reader.read();
    if (value) {
      return new TextDecoder().decode(value).slice(0, 256);
    }
  } finally {
    reader.releaseLock();
  }
  return '';
};

const firstNonWhitespaceChar = (text: string): string => {
  const trimmed = text.replace(/^\uFEFF/, '').trimStart();
  return trimmed.charAt(0);
};

const isJsonPayloadPrefix = (text: string): boolean => {
  const first = firstNonWhitespaceChar(text);
  return first === '{' || first === '[';
};

const concatUint8Chunks = (chunks: Uint8Array[]): Uint8Array => {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
};

type WebStreamProbeResult =
  | { kind: 'json'; data: unknown }
  | { kind: 'stream'; stream: Uint8ReadableStream };

const probeEventStreamBodyForJson = async (
  body: Uint8ReadableStream,
  timeoutMs: number
): Promise<WebStreamProbeResult> => {
  const tee = (body as Uint8ReadableStream & {
    tee?: () => [Uint8ReadableStream, Uint8ReadableStream];
  }).tee;
  if (typeof tee !== 'function') {
    return { kind: 'stream', stream: body };
  }

  const [probeBranch, streamBranch] = tee.call(body);
  const reader = probeBranch.getReader();
  let timeoutId: NodeJS.Timeout | undefined;
  try {
    const firstRead = reader.read();
    const timeout = new Promise<'timeout'>((resolve) => {
      timeoutId = setTimeout(() => resolve('timeout'), timeoutMs);
      timeoutId.unref?.();
    });
    const first = await Promise.race([firstRead, timeout]);
    if (first === 'timeout') {
      reader.cancel().catch(() => {
        // ignore probe cleanup
      });
      return { kind: 'stream', stream: streamBranch };
    }
    if (first.done || !first.value) {
      reader.cancel().catch(() => {
        // ignore probe cleanup
      });
      return { kind: 'stream', stream: streamBranch };
    }

    const decoder = new TextDecoder();
    const firstText = decoder.decode(first.value, { stream: true });
    if (!isJsonPayloadPrefix(firstText)) {
      reader.cancel().catch(() => {
        // ignore probe cleanup
      });
      return { kind: 'stream', stream: streamBranch };
    }

    const chunks: Uint8Array[] = [first.value];
    while (true) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      if (next.value) {
        chunks.push(next.value);
      }
    }
    try {
      await streamBranch.cancel();
    } catch {
      // ignore unused branch cleanup
    }
    const text = new TextDecoder().decode(concatUint8Chunks(chunks));
    return {
      kind: 'json',
      data: JSON.parse(text)
    };
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    try {
      reader.releaseLock();
    } catch {
      // ignore release after cancel/end
    }
  }
};

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

const formatNonBlockingHttpClientError = (
  stage: string,
  error: unknown
): string => {
  if (
    stage === 'sendSingleRequest.errorBodyParse' &&
    error instanceof Error
  ) {
    return `${error.name}: ${error.message}`;
  }
  return formatUnknownError(error);
};

const logHttpClientNonBlockingError = (
  stage: string,
  error: unknown,
  details?: Record<string, unknown>
): void => {
  try {
    const detailSuffix = details && Object.keys(details).length > 0 ? ` details=${JSON.stringify(details)}` : '';
    console.warn(`[http-client] ${stage} failed (non-blocking): ${formatNonBlockingHttpClientError(stage, error)}${detailSuffix}`);
  } catch {
    // Never throw from non-blocking logging.
  }
};

const isHttpSendTraceEnabled = (): boolean => {
  const raw = String(
    process.env.ROUTECODEX_HTTP_SEND_TRACE ||
    process.env.RCC_HTTP_SEND_TRACE ||
    ''
  ).trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'trace';
};

const safeUrlSummary = (url: string): Record<string, unknown> => {
  try {
    const parsed = new URL(url);
    return {
      protocol: parsed.protocol,
      host: parsed.host,
      path: parsed.pathname
    };
  } catch {
    return { urlKind: /^https?:\/\//i.test(url) ? 'absolute-invalid' : 'relative' };
  }
};

const buildPostStreamTrace = (
  url: string,
  data: unknown,
  extra: Record<string, unknown>
): Record<string, unknown> => {
  let bodyBytes = 0;
  let model: unknown;
  let stream: unknown;
  let inputLen: unknown;
  let toolsLen: unknown;
  try {
    const bodyText = data !== undefined ? JSON.stringify(data) : '';
    bodyBytes = Buffer.byteLength(bodyText);
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      const body = data as Record<string, unknown>;
      model = typeof body.model === 'string' ? body.model : undefined;
      stream = typeof body.stream === 'boolean' ? body.stream : undefined;
      inputLen = Array.isArray(body.input) ? body.input.length : undefined;
      toolsLen = Array.isArray(body.tools) ? body.tools.length : undefined;
    }
  } catch {
    bodyBytes = -1;
  }
  return {
    ...safeUrlSummary(url),
    bodyBytes,
    ...(model !== undefined ? { model } : {}),
    ...(stream !== undefined ? { stream } : {}),
    ...(inputLen !== undefined ? { inputLen } : {}),
    ...(toolsLen !== undefined ? { toolsLen } : {}),
    ...extra
  };
};

const logHttpSendTrace = (
  stage: string,
  url: string,
  data: unknown,
  extra: Record<string, unknown>
): void => {
  if (!isHttpSendTraceEnabled()) {
    return;
  }
  try {
    console.warn(`[http-client.postStream.${stage}] ${JSON.stringify(buildPostStreamTrace(url, data, extra))}`);
  } catch {
    // trace must never affect transport
  }
};

export class HttpClient {
  private config: HttpClientConfig;
  private defaultConfig: Required<HttpClientConfig>;

  constructor(config: HttpClientConfig = {}) {
    this.config = config;
    this.defaultConfig = {
      baseUrl: config.baseUrl || '',
      // 默认 HTTP 请求超时时间（未显式配置时）：500s
      timeout: config.timeout || 500000,
      maxRetries: 0,
      retryDelay: 0,
      defaultHeaders: {
        'Content-Type': 'application/json'
      },
      streamIdleTimeoutMs: config.streamIdleTimeoutMs ?? NaN,
      streamHeadersTimeoutMs: config.streamHeadersTimeoutMs ?? NaN
    };
  }

  /**
   * 发送GET请求
   */
  async get(url: string, headers?: Record<string, string>): Promise<HttpResponse> {
    return this.request('GET', url, undefined, headers);
  }

  /**
   * 发送POST请求
   */
  async post(
    url: string,
    data?: unknown,
    headers?: Record<string, string>,
    signal?: AbortSignal
  ): Promise<HttpResponse> {
    return this.request('POST', url, data, headers, signal);
  }

  /**
   * 发送POST请求并返回可读流（适用于 SSE ）
   */
  async postStream(
    url: string,
    data?: unknown,
    headers?: Record<string, string>,
    streamConfig?: {
      timeoutMs?: number;
      idleTimeoutMs?: number;
      headersTimeoutMs?: number;
    },
    signal?: AbortSignal
  ): Promise<NodeJS.ReadableStream> {
    const result = await this.postStreamOrResponse(url, data, headers, streamConfig, signal);
    if (result.kind === 'stream') {
      return result.stream;
    }
    throw Object.assign(
      new Error(`Upstream returned non-SSE response for streaming request: ${result.responseKind}`),
      {
        code: 'UPSTREAM_RESPONSE_NOT_SSE',
        status: result.response.status,
        statusCode: result.response.status,
        response: result.response,
        retryable: false
      }
    );
  }

  /**
   * 发送POST请求，按真实上游响应类型返回 SSE stream 或 JSON/text response。
   */
  async postStreamOrResponse(
    url: string,
    data?: unknown,
    headers?: Record<string, string>,
    streamConfig?: {
      timeoutMs?: number;
      idleTimeoutMs?: number;
      headersTimeoutMs?: number;
    },
    signal?: AbortSignal
  ): Promise<HttpStreamOrResponse> {
    const fullUrl = this.buildUrl(url);
    const finalHeaders = this.buildHeaders({ Accept: 'text/event-stream', ...(headers || {}) });

    const controller = new AbortController();
    const timeout = Number.isFinite(streamConfig?.timeoutMs) && Number(streamConfig?.timeoutMs) > 0
      ? Number(streamConfig?.timeoutMs)
      : this.defaultConfig.timeout;
    // NOTE:
    // - 在收到响应 headers 之前，需要一个绝对超时来暴露“上游完全不返回”。
    // - 一旦 headers/body 已经到手，就必须切换为“有锚点的流式超时”：
    //   headers timeout / byte idle timeout / 下游语义超时。
    //   继续保留全局 absolute timeout 会把长流硬砍成 UPSTREAM_STREAM_TIMEOUT，
    //   破坏基于语义锚点的超时设计。
    const overrideIdle = Number(streamConfig?.idleTimeoutMs);
    const cfgIdle = this.defaultConfig.streamIdleTimeoutMs;
    const idleTimeoutMs = Number.isFinite(overrideIdle) && overrideIdle > 0
      ? overrideIdle
      : Number.isFinite(cfgIdle) && cfgIdle > 0
      ? cfgIdle
      : Math.min(DEFAULT_TIMEOUTS.PROVIDER_STREAM_IDLE_CAP_MS, timeout);
    const overrideHeaders = Number(streamConfig?.headersTimeoutMs);
    const cfgHeaders = this.defaultConfig.streamHeadersTimeoutMs;
    // NOTE: headers timeout controls how long we wait for the *first response headers* from upstream.
    // Some upstreams are slow to flush headers for SSE; keep this fairly generous by default.
    const headersTimeoutMs = Number.isFinite(overrideHeaders) && overrideHeaders > 0
      ? overrideHeaders
      : Number.isFinite(cfgHeaders) && cfgHeaders > 0
      ? cfgHeaders
      : Math.min(DEFAULT_PROVIDER.STREAM_HEADERS_TIMEOUT_MS, timeout);
    const startedAt = Date.now();
    logHttpSendTrace('start', fullUrl, data, {
      timeoutMs: timeout,
      idleTimeoutMs,
      headersTimeoutMs,
      configuredHeadersTimeoutMs: Number.isFinite(cfgHeaders) ? cfgHeaders : null,
      overrideHeadersTimeoutMs: Number.isFinite(overrideHeaders) ? overrideHeaders : null
    });
    const abortWithReason = (reason: string) => {
      try {
        const err = Object.assign(new Error(reason), { code: reason, name: 'AbortError' });
        // Node 18+ 支持 abort(reason)，fetch 侧会以该 reason 失败。
        (controller as unknown as { abort: (reason?: unknown) => void }).abort(err);
      } catch {
        controller.abort();
      }
    };
    const timeoutId = setTimeout(() => abortWithReason('UPSTREAM_STREAM_TIMEOUT'), timeout);
    const headersTimeoutId = setTimeout(() => abortWithReason('UPSTREAM_HEADERS_TIMEOUT'), headersTimeoutMs);
    const detachExternalAbort = this.attachExternalAbortSignal(controller, signal);

    try {
      const fetchOptions: RequestInit = {
        method: 'POST',
        headers: finalHeaders,
        body: data !== undefined ? JSON.stringify(data) : undefined,
        signal: controller.signal
      };

      const response = await fetch(fullUrl, fetchOptions);
      logHttpSendTrace('headers', fullUrl, data, {
        elapsedMs: Date.now() - startedAt,
        status: response.status,
        ok: response.ok
      });
      clearTimeout(headersTimeoutId);
      clearTimeout(timeoutId);
      if (!response.ok) {
        // 与非流式 request 保持一致：在错误中包含上游返回体，但对 message 进行截断，避免控制台刷屏。
        const errorText = await response.text();
        const headersObj: Record<string, string> = {};
        try {
          response.headers.forEach((value, key) => { headersObj[key] = value; });
        } catch (headerError) {
          logHttpClientNonBlockingError('requestInternal.errorHeadersParse', headerError, { url, status: response.status });
        }
        const message = this.buildHttpErrorMessage(response.status, errorText);
        const err: UpstreamError = new Error(message) as UpstreamError;
        err.status = response.status;
        err.statusCode = response.status;
        err.response = {
          data: undefined,
          raw: errorText
        };
        err.headers = headersObj;
        err.retryable = false;
        throw err;
      }

      const headersObj: Record<string, string> = {};
      response.headers.forEach((value, key) => { headersObj[key] = value; });
      const contentType = (headersObj['content-type'] || headersObj['Content-Type'] || '').toLowerCase();
      if (!contentType.includes('text/event-stream')) {
        const isJson = contentType.includes('application/json') || contentType.includes('+json');
        const responseData = isJson ? await response.json() : await response.text();
        detachExternalAbort();
        return {
          kind: 'response',
          responseKind: isJson ? 'json' : 'text',
          response: {
            data: responseData,
            status: response.status,
            statusText: response.statusText,
            headers: headersObj,
            url
          }
        };
      }

      // Convert WHATWG ReadableStream to Node.js Readable for pipeline streaming
      const body = response.body as StreamBody;
      if (body) {
        if (isNodeReadable(body)) {
          const stream = this.wrapStreamWithTimeouts(
              body,
              controller,
              idleTimeoutMs,
              abortWithReason,
              detachExternalAbort
            );
          return {
            kind: 'stream',
            stream,
            status: response.status,
            statusText: response.statusText,
            headers: headersObj,
            url
          };
        }
        if (isWebReadableStream(body)) {
          try {
            const probed = await probeEventStreamBodyForJson(body, Math.min(250, idleTimeoutMs));
            if (probed.kind === 'json') {
              detachExternalAbort();
              return {
                kind: 'response',
                responseKind: 'json',
                response: {
                  data: probed.data,
                  status: response.status,
                  statusText: response.statusText,
                  headers: headersObj,
                  url
                }
              };
            }
            if (typeof Readable.fromWeb === 'function') {
              const nodeStream = Readable.fromWeb(probed.stream, { highWaterMark: 256 * 1024 });
              if (isNodeReadable(nodeStream)) {
                const stream = this.wrapStreamWithTimeouts(
                    nodeStream,
                    controller,
                    idleTimeoutMs,
                    abortWithReason,
                    detachExternalAbort
                  );
                return {
                  kind: 'stream',
                  stream,
                  status: response.status,
                  statusText: response.statusText,
                  headers: headersObj,
                  url
                };
              }
            }
          } catch (conversionError) {
            logHttpClientNonBlockingError('postStream.convertWebReadable', conversionError, {
              url: fullUrl
            });
          }
        }
      }

      clearTimeout(timeoutId);
      detachExternalAbort();
      // As a last resort, throw to let caller decide (should not fallback silently)
      throw new Error('Upstream response body is not streamable');
    } catch (error) {
      clearTimeout(timeoutId);
      clearTimeout(headersTimeoutId);
      detachExternalAbort();
      logHttpSendTrace('error', fullUrl, data, {
        elapsedMs: Date.now() - startedAt,
        errorName: error instanceof Error ? error.name : typeof error,
        errorMessage: error instanceof Error ? error.message : String(error),
        errorCode: typeof (error as { code?: unknown })?.code === 'string'
          ? (error as { code: string }).code
          : undefined
      });
      throw this.createProviderError(error);
    }
  }

  private wrapStreamWithTimeouts(
    upstream: NodeJS.ReadableStream,
    controller: AbortController,
    idleTimeoutMs: number,
    abortWithReason: (reason: string) => void,
    detachExternalAbort: () => void
  ): NodeJS.ReadableStream {
    let cleaned = false;
    let streamEnded = false;
    let lastActivityAt = Date.now();
    let idleWatchdog: NodeJS.Timeout | null = null;
    const onAbort = () => {
      cleanup();
      try {
        const reason = (controller.signal as { reason?: unknown }).reason;
        const destroyable = upstream as unknown as { destroy?: (error?: Error) => void };
        if (reason instanceof Error) {
          destroyable.destroy?.(reason);
        } else if (reason !== undefined) {
          destroyable.destroy?.(Object.assign(new Error(String(reason)), { code: 'UPSTREAM_STREAM_ABORTED' }));
        } else {
          destroyable.destroy?.(Object.assign(new Error('UPSTREAM_STREAM_ABORTED'), { code: 'UPSTREAM_STREAM_ABORTED' }));
        }
      } catch {
        try {
          const destroyable = upstream as unknown as { destroy?: () => void };
          destroyable.destroy?.();
        } catch {
          // ignore
        }
      }
    };

    const clearTimers = () => {
      if (idleWatchdog) {
        clearInterval(idleWatchdog);
        idleWatchdog = null;
      }
    };

    const cleanup = () => {
      if (cleaned) {
        return;
      }
      cleaned = true;
      clearTimers();
      detachExternalAbort();
      try {
        controller.signal.removeEventListener?.('abort', onAbort as unknown as EventListener);
        upstream.removeListener('data', onData);
        upstream.removeListener('end', onEnd);
        upstream.removeListener('error', onError);
        upstream.removeListener('close', onClose);
      } catch (removeListenerError) {
        logHttpClientNonBlockingError('wrapStreamWithTimeouts.cleanup', removeListenerError);
      }
    };

    const updateLastActivity = () => {
      lastActivityAt = Date.now();
    };

    const startIdleWatchdog = () => {
      if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) {
        return;
      }
      const intervalMs = Math.max(50, Math.min(1_000, Math.floor(idleTimeoutMs / 2) || 50));
      idleWatchdog = setInterval(() => {
        if (cleaned || streamEnded) {
          return;
        }
        if (Date.now() - lastActivityAt < idleTimeoutMs) {
          return;
        }
        abortWithReason('UPSTREAM_STREAM_IDLE_TIMEOUT');
        try {
          const destroyable = upstream as unknown as { destroy?: (error?: Error) => void };
          destroyable.destroy?.(
            Object.assign(new Error('UPSTREAM_STREAM_IDLE_TIMEOUT'), { code: 'UPSTREAM_STREAM_IDLE_TIMEOUT' })
          );
        } catch (destroyError) {
          logHttpClientNonBlockingError('wrapStreamWithTimeouts.idleTimeoutDestroy', destroyError);
          try {
            const destroyable = upstream as unknown as { destroy?: () => void };
            destroyable.destroy?.();
          } catch {
            // ignore
          }
        }
      }, intervalMs);
      idleWatchdog.unref?.();
    };

    const onData = () => {
      updateLastActivity();
    };

    const onEnd = () => {
      streamEnded = true;
      cleanup();
    };

    const onError = (error: unknown) => {
      cleanup();
    };

    const onClose = () => {
      const closedBeforeEnd = !streamEnded;
      cleanup();
      if (!closedBeforeEnd) {
        return;
      }
      try {
        controller.abort();
      } catch (abortError) {
        logHttpClientNonBlockingError('wrapStreamWithTimeouts.closeAbort', abortError);
      }
    };

    try {
      controller.signal.addEventListener?.('abort', onAbort as unknown as EventListener, { once: true } as AddEventListenerOptions);
    } catch (addListenerError) {
      logHttpClientNonBlockingError('wrapStreamWithTimeouts.addAbortListener', addListenerError);
    }

    startIdleWatchdog();
    upstream.on('data', onData);
    upstream.on('end', onEnd);
    upstream.on('error', onError);
    upstream.on('close', onClose);

    return upstream;
  }

  /**
   * 发送PUT请求
   */
  async put(
    url: string,
    data?: unknown,
    headers?: Record<string, string>,
    signal?: AbortSignal
  ): Promise<HttpResponse> {
    return this.request('PUT', url, data, headers, signal);
  }

  /**
   * 发送DELETE请求
   */
  async delete(url: string, headers?: Record<string, string>, signal?: AbortSignal): Promise<HttpResponse> {
    return this.request('DELETE', url, undefined, headers, signal);
  }

  /**
   * 发送PATCH请求
   */
  async patch(
    url: string,
    data?: unknown,
    headers?: Record<string, string>,
    signal?: AbortSignal
  ): Promise<HttpResponse> {
    return this.request('PATCH', url, data, headers, signal);
  }

  /**
   * 通用请求方法
   */
  private async request(
    method: HttpRequestConfig['method'],
    url: string,
    data?: unknown,
    headers?: Record<string, string>,
    signal?: AbortSignal
  ): Promise<HttpResponse> {
    const fullUrl = this.buildUrl(url);
    const requestConfig: HttpRequestConfig = {
      method,
      headers: this.buildHeaders(headers),
      timeout: this.defaultConfig.timeout,
      maxRetries: 0,
      retryDelay: 0,
      signal
    };

    try {
      return await this.sendSingleRequest(fullUrl, data, requestConfig);
    } catch (error) {
      throw this.createProviderError(error);
    }
  }

  /**
   * 发送单个请求
   */
  private async sendSingleRequest(
    url: string,
    data: unknown,
    config: HttpRequestConfig
  ): Promise<HttpResponse> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.timeout);
    const detachExternalAbort = this.attachExternalAbortSignal(controller, config.signal);

    try {
      const fetchOptions: RequestInit = {
        method: config.method,
        headers: config.headers,
        signal: controller.signal
      };

      // 添加请求体（如果有）
      if (data !== undefined) {
        const binaryLike =
          data instanceof ArrayBuffer ||
          ArrayBuffer.isView(data) ||
          (typeof Buffer !== 'undefined' && data instanceof Buffer);
        fetchOptions.body = typeof data === 'string' || binaryLike
          ? (data as BodyInit)
          : JSON.stringify(data);
      }

      const response = await fetch(url, fetchOptions);
      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        const headersObj: Record<string, string> = {};
        try {
          response.headers.forEach((value, key) => { headersObj[key] = value; });
        } catch (headerError) {
          logHttpClientNonBlockingError('sendSingleRequest.errorHeadersParse', headerError, { url, status: response.status });
        }
        let parsed: unknown;
        if (
          errorText &&
          (response.headers.get('content-type')?.includes('application/json') ||
            errorText.charCodeAt(0) === 0x7b /* '{' */ ||
            errorText.charCodeAt(0) === 0x5b /* '[' */)
        ) {
          try {
            parsed = JSON.parse(errorText);
          } catch (parseError) {
            logHttpClientNonBlockingError('sendSingleRequest.errorBodyParse', parseError, { url, status: response.status });
            parsed = undefined;
          }
        }
        const message = this.buildHttpErrorMessage(response.status, errorText);
        const err: UpstreamError = new Error(message) as UpstreamError;
        err.status = response.status;
        err.statusCode = response.status;
        if (parsed && typeof parsed === 'object' && 'error' in parsed) {
          const upstreamError = (parsed as { error?: { code?: string; type?: string } }).error;
          if (upstreamError) {
            err.code = upstreamError.code || upstreamError.type;
          }
        }
        err.response = {
          data: parsed,
          raw: errorText
        };
        err.headers = headersObj;
        err.retryable = false;
        throw err;
      }

      // 根据 Content-Type 判断响应类型
      const ct = (response.headers.get('content-type') || response.headers.get('Content-Type') || '').toLowerCase();
      // 事件流（SSE）：在非显式流式模式下禁止透传，直接抛错交由上层处理（避免静默失败/挂起）
      if (ct.includes('text/event-stream')) {
        const headersObj: Record<string, string> = {};
        response.headers.forEach((value, key) => { headersObj[key] = value; });
        let peek = '';
        try {
          const body = response.body as StreamBody;
          if (body && isWebReadableStream(body)) {
            peek = await peekReadableStream(body);
          } else {
            peek = (await response.text()).slice(0, 256);
          }
        } catch (peekError) {
          logHttpClientNonBlockingError('requestInternal.ssePeek', peekError, { url, status: response.status });
        }
        const err: UpstreamError = new Error(`UPSTREAM_SSE_NOT_ALLOWED: received text/event-stream while expecting JSON. peek=${peek}`) as UpstreamError;
        err.code = 'UPSTREAM_SSE_NOT_ALLOWED';
        err.statusCode = response.status;
        err.headers = headersObj;
        throw err;
      }

      // 非 JSON：返回纯文本
      if (!ct.includes('application/json')) {
        const textData = await response.text();
        const headersObj: Record<string, string> = {};
        response.headers.forEach((value, key) => { headersObj[key] = value; });
        detachExternalAbort();
        return {
          data: textData,
          status: response.status,
          statusText: response.statusText,
          headers: headersObj,
          url
        };
      }

      const responseData = await response.json();

      // 手动转换Headers对象为普通对象
      const headersObj: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headersObj[key] = value;
      });

      detachExternalAbort();
      return {
        data: responseData,
        status: response.status,
        statusText: response.statusText,
        headers: headersObj,
        url
      };

    } catch (error) {
      clearTimeout(timeoutId);
      detachExternalAbort();
      throw error;
    }
  }

  private attachExternalAbortSignal(controller: AbortController, signal?: AbortSignal): () => void {
    if (!signal) {
      return () => {};
    }
    const abort = () => {
      try {
        const reason = (signal as { reason?: unknown }).reason;
        if (reason !== undefined) {
          (controller as unknown as { abort: (reason?: unknown) => void }).abort(reason);
        } else {
          controller.abort();
        }
      } catch {
        controller.abort();
      }
    };
    if (signal.aborted) {
      abort();
      return () => {};
    }
    const listener = () => abort();
    signal.addEventListener?.('abort', listener as EventListener, { once: true } as AddEventListenerOptions);
    return () => {
      try {
        signal.removeEventListener?.('abort', listener as EventListener);
      } catch {
        // ignore cleanup errors
      }
    };
  }

  /**
   * 为 HTTP 错误构造截断后的错误消息，避免在控制台打印过长的上游返回体。
   * 完整 body 仍通过 err.response.raw 保留在错误详情中。
   */
  private buildHttpErrorMessage(status: number, body: string): string {
    if (!body) {
      return `HTTP ${status}`;
    }
    const maxLength = 500;
    if (body.length <= maxLength) {
      return `HTTP ${status}: ${body}`;
    }
    const truncated = body.slice(0, maxLength);
    const omitted = body.length - truncated.length;
    return `HTTP ${status}: ${truncated}...[truncated ${omitted} chars]`;
  }

  /**
   * 构建完整URL
   */
  private buildUrl(path: string): string {
    // 若传入的是完整URL，直接返回，避免与 baseUrl 重复拼接
    if (/^https?:\/\//i.test(path)) {
      return path;
    }

    const baseUrl = this.defaultConfig.baseUrl;
    if (!baseUrl) {
      return path;
    }

    // 移除开头的斜杠避免重复
    const cleanPath = path.startsWith('/') ? path.substring(1) : path;
    return `${baseUrl.replace(/\/$/, '')}/${cleanPath}`;
  }

  /**
   * 构建请求头
   */
  private buildHeaders(headers?: Record<string, string>): Record<string, string> {
    return {
      ...this.defaultConfig.defaultHeaders,
      ...this.config.defaultHeaders,
      ...headers
    };
  }

  /**
   * 判断是否应该重试
   */
  private shouldRetry(error: unknown): boolean {
    const err = error as UpstreamError;

    // 某些上游聚合器（特别是 Anthropic 兼容层）会将“非 2xx 状态码”包装为
    // OpenAI 风格的错误对象，message 中包含 openai_error / bad_response_status_code。
    // 这些属于“逻辑错误”，而不是瞬时网络问题，必须直接失败，避免在 HTTP 客户端层重试形成风暴。
    try {
      const msg = typeof err?.message === 'string' ? err.message : String(err ?? '');
      if (/openai_error/i.test(msg) || /bad_response_status_code/i.test(msg)) {
        return false;
      }
    } catch (messageParseError) {
      logHttpClientNonBlockingError('shouldRetry.messageParse', messageParseError);
    }

    // 网络错误通常可以重试
    if (err?.name === 'TypeError' || err?.code === 'ECONNREFUSED') {
      return true;
    }

    // HTTP状态码错误
    if (err?.message) {
      const statusMatch = err.message.match(/HTTP (\d{3})/);
      if (statusMatch) {
        const status = parseInt(statusMatch[1]);
        return status >= 500;
      }
    }
    if (typeof err.status === 'number') {
      return err.status >= 500;
    }
    if (typeof err.statusCode === 'number') {
      return err.statusCode >= 500;
    }

    // AbortError（超时）可以重试
    if (err?.name === 'AbortError') {
      return true;
    }

    return false;
  }

  /**
   * 创建Provider错误
   */
  private createProviderError(error: unknown): ProviderError {
    const baseError = error instanceof Error ? error : new Error(String(error));
    const providerError = baseError as ProviderError;
    const err = baseError as UpstreamError;

    // 设置错误类型
    if (err.name === 'AbortError' || err.message?.includes('timeout')) {
      providerError.type = 'network';
    } else if (err.message?.includes('HTTP 4')) {
      providerError.type = 'server';
    } else if (err.message?.includes('401') || err.message?.includes('403')) {
      providerError.type = 'authentication';
    } else {
      providerError.type = 'unknown';
    }

    // 提取状态码
    const statusMatch = err.message?.match(/HTTP (\d{3})/);
    let statusCode: number | undefined;
    if (statusMatch) {
      statusCode = parseInt(statusMatch[1]);
    } else if (typeof err?.status === 'number') {
      statusCode = err.status;
    } else if (typeof err?.statusCode === 'number') {
      statusCode = err.statusCode;
    }
    if (statusCode) {
      providerError.statusCode = statusCode;
    }
    if (err?.code && typeof err.code === 'string') {
      providerError.code = err.code;
    }

    // 设置重试标记
    if (typeof statusCode === 'number') {
      err.statusCode = statusCode;
    }
    providerError.retryable = this.shouldRetry(err);

    // 设置错误详情
    const originalError =
      error instanceof Error
        ? {
            name: error.name,
            message: error.message,
            ...(typeof (error as any)?.code === 'string' ? { code: (error as any).code } : {}),
            ...(typeof (error as any)?.statusCode === 'number' ? { statusCode: (error as any).statusCode } : {})
          }
        : error;
    providerError.details = {
      originalError,
      response: {
        ...(err?.response || {}),
        ...(err?.headers ? { headers: err.headers } : {})
      }
    };

    return providerError;
  }

}
