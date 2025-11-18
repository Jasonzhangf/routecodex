/**
 * HTTP Client - 统一HTTP客户端
 *
 * 提供统一的HTTP请求处理功能
 */

import type { ProviderError } from '../api/provider-types.js';

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
export class HttpClient {
  private config: HttpClientConfig;
  private defaultConfig: Required<HttpClientConfig>;

  constructor(config: HttpClientConfig = {}) {
    this.config = config;
    this.defaultConfig = {
      baseUrl: config.baseUrl || '',
      timeout: config.timeout || 60000,
      maxRetries: config.maxRetries || 3,
      retryDelay: config.retryDelay || 1000,
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
  ): Promise<any> {
    const fullUrl = this.buildUrl(url);
    const finalHeaders = this.buildHeaders({ 'Accept': 'text/event-stream', ...(headers || {}) });

    const controller = new AbortController();
    const timeout = this.defaultConfig.timeout;
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const fetchOptions: any = {
        method: 'POST',
        headers: finalHeaders,
        body: data !== undefined ? JSON.stringify(data) : undefined,
        signal: controller.signal
      };

      const response = await fetch(fullUrl, fetchOptions as any);
      if (!response.ok) {
        // 与非流式 request 保持一致：在错误中包含上游返回体，便于快照/日志分析
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      // Convert WHATWG ReadableStream to Node.js Readable for pipeline streaming
      const anyRes: any = response as any;
      const body: any = (response as any).body;
      if (body && typeof (body as any).getReader === 'function') {
        try {
          const { Readable } = await import('node:stream');
          const nodeStream = (Readable as any).fromWeb ? (Readable as any).fromWeb(body) : undefined;
          if (nodeStream && typeof nodeStream.pipe === 'function') {
            return nodeStream; // streaming-manager expects .pipe()
          }
        } catch { /* ignore conversion errors */ }
      }

      // If body is not a web stream or conversion failed, try lower-level access
      if (anyRes && typeof anyRes.pipe === 'function') {
        return anyRes; // already a Node readable
      }

      // As a last resort, throw to let caller decide (should not fallback silently)
      throw new Error('Upstream response body is not streamable');
    } finally {
      clearTimeout(timeoutId);
    }
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
    method: string,
    url: string,
    data?: unknown,
    headers?: Record<string, string>
  ): Promise<HttpResponse> {
    const fullUrl = this.buildUrl(url);
    const requestConfig: HttpRequestConfig = {
      method: method as any,
      headers: this.buildHeaders(headers),
      timeout: this.defaultConfig.timeout,
      maxRetries: this.defaultConfig.maxRetries,
      retryDelay: this.defaultConfig.retryDelay
    };

    return this.sendRequestWithRetry(fullUrl, data, requestConfig);
  }

  /**
   * 带重试的请求发送
   */
  private async sendRequestWithRetry(
    url: string,
    data: unknown,
    config: HttpRequestConfig
  ): Promise<HttpResponse> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= config.maxRetries!; attempt++) {
      try {
        return await this.sendSingleRequest(url, data, config);
      } catch (error) {
        lastError = error;

        // 检查是否应该重试
        if (!this.shouldRetry(error, attempt, config.maxRetries!)) {
          break;
        }

        // 等待重试延迟
        if (config.retryDelay && attempt < config.maxRetries!) {
          const delay = config.retryDelay * Math.pow(2, attempt); // 指数退避
          await this.delay(delay);
        }
      }
    }

    throw this.createProviderError(lastError);
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

      // 添加请求体（如果有）
      if (data !== undefined) {
        fetchOptions.body = typeof data === 'string' ? data : JSON.stringify(data);
      }

      const response = await fetch(url, fetchOptions);
      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
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
  private shouldRetry(error: unknown, attempt: number, maxRetries: number): boolean {
    if (attempt >= maxRetries) {
      return false;
    }

    const err = error as any;

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
    if (err.name === 'TypeError' || err.code === 'ECONNREFUSED') {
      return true;
    }

    // HTTP状态码错误
    if (err.message) {
      const statusMatch = err.message.match(/HTTP (\d{3})/);
      if (statusMatch) {
        const status = parseInt(statusMatch[1]);
        // 仅 5xx 服务器错误可在 HTTP 客户端层重试；
        // 429 的退避与切换由 PipelineManager 统一处理（避免重复策略）。
        return status >= 500;
      }
    }

    // AbortError（超时）可以重试
    if (err.name === 'AbortError') {
      return true;
    }

    return false;
  }

  /**
   * 创建Provider错误
   */
  private createProviderError(error: unknown): ProviderError {
    const providerError: ProviderError = error instanceof Error ? error as ProviderError : new Error(String(error)) as ProviderError;
    const err = error as any;

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
    if (statusMatch) {
      providerError.statusCode = parseInt(statusMatch[1]);
    }

    // 设置重试标记
    providerError.retryable = this.shouldRetry(error, 0, 0);

    // 设置错误详情
    providerError.details = {
      originalError: error
    };

    return providerError;
  }

  /**
   * 延迟执行
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
