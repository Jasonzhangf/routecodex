/**
 * HTTP Client - 统一HTTP客户端
 *
 * 提供统一的HTTP请求处理功能
 */

import type {
  ReadableStream as WebReadableStream,
  ReadableStreamDefaultReader
} from 'node:stream/web';
import type { ProviderError } from '../api/provider-types.js';
import { PassThrough } from 'node:stream';

/**
 * HTTP请求配置
 */
export interface HttpRequestConfig {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  headers?: Record<string, string>;
  timeout?: number;
  maxRetries?: number;
  retryDelay?: number;
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

/**
 * HTTP客户端配置
 */
export interface HttpClientConfig {
  baseUrl?: string;
  timeout?: number;
  maxRetries?: number;
  retryDelay?: number;
  defaultHeaders?: Record<string, string>;
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
      }
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
    headers?: Record<string, string>
  ): Promise<HttpResponse> {
    return this.request('POST', url, data, headers);
  }

  /**
   * 发送POST请求并返回可读流（适用于 SSE ）
   */
  async postStream(
    url: string,
    data?: unknown,
    headers?: Record<string, string>
  ): Promise<NodeJS.ReadableStream> {
    const fullUrl = this.buildUrl(url);
    const finalHeaders = this.buildHeaders({ Accept: 'text/event-stream', ...(headers || {}) });

    const controller = new AbortController();
    const timeout = this.defaultConfig.timeout;
    // NOTE: stream 请求如果在拿到 response body 后立刻清除 timeout，会导致“流式卡死不返回”。
    // 这里维持一个全局 timeout + idle timeout，直到上游流结束或被消费者关闭。
    const envIdle = Number(
      process.env.ROUTECODEX_PROVIDER_STREAM_IDLE_TIMEOUT_MS ||
        process.env.RCC_PROVIDER_STREAM_IDLE_TIMEOUT_MS ||
        NaN
    );
    const idleTimeoutMs = Number.isFinite(envIdle) && envIdle > 0 ? envIdle : Math.min(120_000, timeout);
    const abortWithReason = (reason: string) => {
      try {
        const err = Object.assign(new Error(reason), { code: reason });
        // Node 18+ 支持 abort(reason)，fetch 侧会以该 reason 失败。
        (controller as unknown as { abort: (reason?: unknown) => void }).abort(err);
      } catch {
        controller.abort();
      }
    };
    const timeoutId = setTimeout(() => abortWithReason('UPSTREAM_STREAM_TIMEOUT'), timeout);

    try {
      // Debug Antigravity upstream HTTP payload for SSE when enabled
      if (process.env.ROUTECODEX_DEBUG_ANTIGRAVITY === '1' && /cloudcode-pa/.test(fullUrl)) {
        try {
          const fs = await import('node:fs/promises');
          const path = await import('node:path');
          const home = process.env.HOME || process.cwd();
          const dumpPath = path.join(home, 'antigravity-rc-http.json');
          const payloadSnapshot = {
            url: fullUrl,
            method: 'POST',
            headers: finalHeaders,
            body: data
          };
          await fs.writeFile(dumpPath, JSON.stringify(payloadSnapshot, null, 2), 'utf8');
          // eslint-disable-next-line no-console
          console.log('[ANTIGRAVITY-HTTP-DEBUG] upstream SSE payload dumped to', dumpPath);
        } catch {
          // best-effort debug logging; ignore failures
        }
      }

      const fetchOptions: RequestInit = {
        method: 'POST',
        headers: finalHeaders,
        body: data !== undefined ? JSON.stringify(data) : undefined,
        signal: controller.signal
      };

      const response = await fetch(fullUrl, fetchOptions);
      if (!response.ok) {
        clearTimeout(timeoutId);
        // 与非流式 request 保持一致：在错误中包含上游返回体，但对 message 进行截断，避免控制台刷屏。
        const errorText = await response.text();
        const message = this.buildHttpErrorMessage(response.status, errorText);
        const err: UpstreamError = new Error(message) as UpstreamError;
        err.status = response.status;
        err.statusCode = response.status;
        err.response = {
          data: undefined,
          raw: errorText
        };
        err.retryable = false;
        throw err;
      }

      // Convert WHATWG ReadableStream to Node.js Readable for pipeline streaming
      const body = response.body as StreamBody;
      if (body) {
        if (isNodeReadable(body)) {
          return this.wrapStreamWithTimeouts(body, controller, timeoutId, idleTimeoutMs, abortWithReason);
        }
        if (isWebReadableStream(body)) {
          try {
            const { Readable } = await import('node:stream');
            if (typeof Readable.fromWeb === 'function') {
              const nodeStream = Readable.fromWeb(body);
              if (isNodeReadable(nodeStream)) {
                return this.wrapStreamWithTimeouts(nodeStream, controller, timeoutId, idleTimeoutMs, abortWithReason);
              }
            }
          } catch {
            // ignore conversion errors and continue to fallback
          }
        }
      }

      clearTimeout(timeoutId);
      // As a last resort, throw to let caller decide (should not fallback silently)
      throw new Error('Upstream response body is not streamable');
    } catch (error) {
      clearTimeout(timeoutId);
      throw this.createProviderError(error);
    }
  }

  private wrapStreamWithTimeouts(
    upstream: NodeJS.ReadableStream,
    controller: AbortController,
    timeoutId: NodeJS.Timeout,
    idleTimeoutMs: number,
    abortWithReason: (reason: string) => void
  ): NodeJS.ReadableStream {
    const pass = new PassThrough();
    let idleTimer: NodeJS.Timeout | null = null;
    let cleaned = false;
    const onAbort = () => {
      cleanup();
      try {
        const reason = (controller.signal as { reason?: unknown }).reason;
        if (reason instanceof Error) {
          pass.destroy(reason);
        } else if (reason !== undefined) {
          pass.destroy(Object.assign(new Error(String(reason)), { code: 'UPSTREAM_STREAM_ABORTED' }));
        } else {
          pass.destroy(Object.assign(new Error('UPSTREAM_STREAM_ABORTED'), { code: 'UPSTREAM_STREAM_ABORTED' }));
        }
      } catch {
        pass.destroy();
      }
    };

    const clearTimers = () => {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      clearTimeout(timeoutId);
    };

    const cleanup = () => {
      if (cleaned) {
        return;
      }
      cleaned = true;
      clearTimers();
      try {
        controller.signal.removeEventListener?.('abort', onAbort as unknown as EventListener);
        upstream.removeListener('data', onData);
        upstream.removeListener('end', onEnd);
        upstream.removeListener('error', onError);
        upstream.removeListener('close', onClose);
      } catch {
        // ignore
      }
    };

    const resetIdle = () => {
      if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) {
        return;
      }
      if (idleTimer) {
        clearTimeout(idleTimer);
      }
      idleTimer = setTimeout(() => {
        abortWithReason('UPSTREAM_STREAM_IDLE_TIMEOUT');
        try {
          pass.destroy(Object.assign(new Error('UPSTREAM_STREAM_IDLE_TIMEOUT'), { code: 'UPSTREAM_STREAM_IDLE_TIMEOUT' }));
        } catch {
          pass.destroy();
        }
      }, idleTimeoutMs);
    };

    const onData = () => {
      resetIdle();
    };

    const onEnd = () => {
      cleanup();
    };

    const onError = (error: unknown) => {
      cleanup();
      // ensure consumer sees error
      try {
        pass.destroy(error as Error);
      } catch {
        pass.destroy();
      }
    };

    const onClose = () => {
      cleanup();
    };

    try {
      controller.signal.addEventListener?.('abort', onAbort as unknown as EventListener, { once: true } as AddEventListenerOptions);
    } catch {
      // ignore addEventListener failures
    }

    resetIdle();
    upstream.on('data', onData);
    upstream.on('end', onEnd);
    upstream.on('error', onError);
    upstream.on('close', onClose);

    // If consumer closes early, abort upstream fetch to avoid leaking sockets.
    pass.on('close', () => {
      cleanup();
      try {
        controller.abort();
      } catch {
        // ignore
      }
      try {
        const destroyable = upstream as unknown as { destroy?: () => void };
        if (typeof destroyable.destroy === 'function') {
          destroyable.destroy();
        }
      } catch {
        // ignore
      }
    });

    upstream.pipe(pass);
    return pass;
  }

  /**
   * 发送PUT请求
   */
  async put(
    url: string,
    data?: unknown,
    headers?: Record<string, string>
  ): Promise<HttpResponse> {
    return this.request('PUT', url, data, headers);
  }

  /**
   * 发送DELETE请求
   */
  async delete(url: string, headers?: Record<string, string>): Promise<HttpResponse> {
    return this.request('DELETE', url, undefined, headers);
  }

  /**
   * 发送PATCH请求
   */
  async patch(
    url: string,
    data?: unknown,
    headers?: Record<string, string>
  ): Promise<HttpResponse> {
    return this.request('PATCH', url, data, headers);
  }

  /**
   * 通用请求方法
   */
  private async request(
    method: HttpRequestConfig['method'],
    url: string,
    data?: unknown,
    headers?: Record<string, string>
  ): Promise<HttpResponse> {
    const fullUrl = this.buildUrl(url);
    const requestConfig: HttpRequestConfig = {
      method,
      headers: this.buildHeaders(headers),
      timeout: this.defaultConfig.timeout,
      maxRetries: 0,
      retryDelay: 0
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

    try {
      const fetchOptions: RequestInit = {
        method: config.method,
        headers: config.headers,
        signal: controller.signal
      };

      // Debug Antigravity upstream HTTP payload when enabled
      if (process.env.ROUTECODEX_DEBUG_ANTIGRAVITY === '1' && /cloudcode-pa/.test(url)) {
        try {
          const fs = await import('node:fs/promises');
          const path = await import('node:path');
          const home = process.env.HOME || process.cwd();
          const dumpPath = path.join(home, 'antigravity-rc-http.json');
          const payloadSnapshot = {
            url,
            method: config.method,
            headers: config.headers,
            body: data
          };
          await fs.writeFile(dumpPath, JSON.stringify(payloadSnapshot, null, 2), 'utf8');
          // eslint-disable-next-line no-console
          console.log('[ANTIGRAVITY-HTTP-DEBUG] upstream payload dumped to', dumpPath);
        } catch {
          // best-effort debug logging; ignore failures
        }
      }

      // 添加请求体（如果有）
      if (data !== undefined) {
        fetchOptions.body = typeof data === 'string' ? data : JSON.stringify(data);
      }

      const response = await fetch(url, fetchOptions);
      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        let parsed: unknown;
        try {
          parsed = errorText ? JSON.parse(errorText) : undefined;
        } catch {
          parsed = undefined;
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
        } catch { /* ignore */ }
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

      return {
        data: responseData,
        status: response.status,
        statusText: response.statusText,
        headers: headersObj,
        url
      };

    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
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
    } catch {
      // ignore parse errors
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
    providerError.details = {
      originalError: error,
      response: err?.response
    };

    return providerError;
  }

}
