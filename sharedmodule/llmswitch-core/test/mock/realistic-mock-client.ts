/**
 * 真实HTTP请求模拟客户端
 * 基于设计文档 docs/ROUNDTRIP_TEST_DESIGN.md:50-105
 */

export interface MockClientConfig {
  apiKey: string;
  baseUrl: string;
  timeoutMs?: number;
  retryCount?: number;
  debugMode?: boolean;
}

export interface SampleData {
  sampleId: string;
  name: string;
  type: 'request' | 'response';
  protocol: 'responses' | 'chat';
  category: string;
  payload: any;
  metadata: {
    headers?: Record<string, string>;
    expectedStreaming?: boolean;
    expectedTools?: string[];
    validationRules?: any[];
    description?: string;
    testFocus?: string[];
  };
}

export interface HttpRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: any;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body?: any;
  chunks?: any[]; // 流式响应的chunk数据
}

export interface Recording {
  timestamp: number;
  request: HttpRequest;
  response: HttpResponse | null;
  duration?: number;
  metadata: {
    traceId: string;
    sampleId?: string;
  };
}

/**
 * 请求录制器
 * 基于设计文档 docs/ROUNDTRIP_TEST_DESIGN.md:111-147
 */
export class RequestRecorder {
  private recordings: Map<string, Recording> = new Map();

  recordRequest(traceId: string, request: HttpRequest): void {
    this.recordings.set(traceId, {
      timestamp: Date.now(),
      request: this.sanitizeRequest(request),
      response: null,
      metadata: { traceId }
    });
  }

  recordResponse(traceId: string, response: HttpResponse): void {
    const recording = this.recordings.get(traceId);
    if (recording) {
      recording.response = this.sanitizeResponse(response);
      recording.duration = Date.now() - recording.timestamp;
    }
  }

  getRecording(traceId: string): Recording | undefined {
    return this.recordings.get(traceId);
  }

  getAllRecordings(): Recording[] {
    return Array.from(this.recordings.values());
  }

  exportSamples(): SampleData[] {
    return Array.from(this.recordings.values())
      .filter(r => r.response !== null)
      .map(r => this.convertToSample(r));
  }

  clear(): void {
    this.recordings.clear();
  }

  private sanitizeRequest(req: HttpRequest): HttpRequest {
    return {
      ...req,
      headers: this.sanitizeHeaders(req.headers),
      body: req.body
    };
  }

  private sanitizeResponse(res: HttpResponse): HttpResponse {
    return {
      ...res,
      headers: this.sanitizeHeaders(res.headers),
      body: res.body,
      chunks: res.chunks
    };
  }

  private sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
    const sanitized = { ...headers };
    // 移除敏感信息但保留结构
    if (sanitized.authorization) {
      sanitized.authorization = 'Bearer [REDACTED]';
    }
    return sanitized;
  }

  private convertToSample(recording: Recording): SampleData {
    if (!recording.response) {
      throw new Error('Cannot convert recording without response to sample');
    }

    return {
      sampleId: recording.metadata.traceId,
      name: `Mock Sample ${recording.metadata.traceId}`,
      type: 'response',
      protocol: this.detectProtocol(recording.request),
      category: 'mock-generated',
      payload: recording.response.body,
      metadata: {
        headers: recording.request.headers,
        description: `Generated from trace ${recording.metadata.traceId}`,
        testFocus: ['mock-validation'],
        expectedStreaming: recording.response.chunks ? true : false
      }
    };
  }

  private detectProtocol(request: HttpRequest): 'responses' | 'chat' {
    // 基于URL和headers检测协议
    if (request.url.includes('/chat/') || request.url.includes('/completions')) {
      return 'chat';
    }
    if (request.url.includes('/messages/') || request.url.includes('/responses/')) {
      return 'responses';
    }

    // 基于headers检测
    if (request.headers['anthropic-version']) {
      return 'responses';
    }

    return 'chat'; // 默认
  }
}

/**
 * 真实请求模拟客户端
 * 基于设计文档 docs/ROUNDTRIP_TEST_DESIGN.md:62-106
 */
export class RealisticMockClient {
  private recorder?: RequestRecorder;

  constructor(
    private config: MockClientConfig,
    recorder?: RequestRecorder
  ) {
    this.recorder = recorder;
  }

  async sendRequest(sample: SampleData): Promise<HttpResponse> {
    // 1. 构建真实HTTP请求
    const httpRequest = this.buildHttpRequest(sample);

    // 2. 添加真实headers
    this.addRealisticHeaders(httpRequest, sample);

    // 3. 记录请求trace
    const traceId = this.generateTraceId();
    this.recorder?.recordRequest(traceId, httpRequest);

    try {
      // 4. 发送到llmswitch-core
      const response = await this.sendToLlmSwitch(httpRequest);

      // 5. 记录响应
      this.recorder?.recordResponse(traceId, response);

      return response;
    } catch (error) {
      const message = getErrorMessage(error);
      const errorResponse: HttpResponse = {
        status: 500,
        headers: {},
        body: { error: message }
      };
      this.recorder?.recordResponse(traceId, errorResponse);
      throw error instanceof Error ? error : new Error(message);
    }
  }

  async sendStreamingRequest(sample: SampleData): Promise<HttpResponse> {
    // 基于sendRequest，但处理流式响应
    const httpRequest = this.buildHttpRequest(sample);
    this.addRealisticHeaders(httpRequest, sample);

    const traceId = this.generateTraceId();
    this.recorder?.recordRequest(traceId, httpRequest);

    try {
      const response = await this.sendStreamingToLlmSwitch(httpRequest);
      this.recorder?.recordResponse(traceId, response);
      return response;
    } catch (error) {
      const message = getErrorMessage(error);
      const errorResponse: HttpResponse = {
        status: 500,
        headers: {},
        body: { error: message }
      };
      this.recorder?.recordResponse(traceId, errorResponse);
      throw error instanceof Error ? error : new Error(message);
    }
  }

  private buildHttpRequest(sample: SampleData): HttpRequest {
    const endpoint = this.getEndpointForProtocol(sample.protocol);

    return {
      method: 'POST',
      url: `${this.config.baseUrl}${endpoint}`,
      headers: {},
      body: sample.payload
    };
  }

  private addRealisticHeaders(req: HttpRequest, sample: SampleData): void {
    // 基础headers
    req.headers['content-type'] = 'application/json';
    req.headers['authorization'] = `Bearer ${this.config.apiKey}`;
    req.headers['user-agent'] = 'test-client/1.0';

    // 协议特定headers
    if (sample.protocol === 'responses') {
      req.headers['anthropic-version'] = '2023-06-01';
      req.headers['anthropic-dangerous-direct-browser-access'] = 'true';
    }

    // 流式响应headers
    if (sample.metadata.expectedStreaming) {
      req.headers['accept'] = 'text/event-stream';
      req.headers['cache-control'] = 'no-cache';
    }

    // 添加样本中的自定义headers
    if (sample.metadata.headers) {
      Object.assign(req.headers, sample.metadata.headers);
    }
  }

  private async sendToLlmSwitch(request: HttpRequest): Promise<HttpResponse> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeoutMs || 30000);

    try {
      const response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body ? JSON.stringify(request.body) : undefined,
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      let body;
      if (response.headers.get('content-type')?.includes('application/json')) {
        body = await response.json();
      } else {
        body = await response.text();
      }

      return {
        status: response.status,
        headers: responseHeaders,
        body
      };
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Request timeout after ${this.config.timeoutMs}ms`);
      }
      throw error instanceof Error ? error : new Error(getErrorMessage(error));
    }
  }

  private async sendStreamingToLlmSwitch(request: HttpRequest): Promise<HttpResponse> {
    // 类似于sendToLlmSwitch，但处理SSE流
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeoutMs || 60000);

    try {
      const response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body ? JSON.stringify(request.body) : undefined,
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      // 收集SSE chunks
      const chunks: any[] = [];
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();

      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          // 解析SSE事件并存储
          const parsedChunks = this.parseSSEChunk(chunk);
          chunks.push(...parsedChunks);
        }
      }

      return {
        status: response.status,
        headers: responseHeaders,
        chunks,
        body: { message: 'Streaming response completed', chunks: chunks.length }
      };
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Streaming request timeout after ${this.config.timeoutMs}ms`);
      }
      throw error instanceof Error ? error : new Error(getErrorMessage(error));
    }
  }

  private parseSSEChunk(chunk: string): any[] {
    const chunks: any[] = [];
    const lines = chunk.split('\n');

    let currentEvent: any = {};
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.substring(6);
        if (data === '[DONE]') {
          chunks.push(currentEvent);
          currentEvent = {};
        } else {
          try {
            currentEvent.data = JSON.parse(data);
          } catch (e) {
            currentEvent.rawData = data;
          }
        }
      } else if (line.startsWith('event: ')) {
        currentEvent.event = line.substring(7);
      } else if (line.startsWith('id: ')) {
        currentEvent.id = line.substring(4);
      } else if (line.startsWith('retry: ')) {
        currentEvent.retry = parseInt(line.substring(7));
      } else if (line.trim() === '') {
        if (Object.keys(currentEvent).length > 0) {
          chunks.push(currentEvent);
          currentEvent = {};
        }
      }
    }

    return chunks;
  }

  private getEndpointForProtocol(protocol: 'responses' | 'chat'): string {
    switch (protocol) {
      case 'responses':
        return '/v1/messages';
      case 'chat':
        return '/v1/chat/completions';
      default:
        throw new Error(`Unknown protocol: ${protocol}`);
    }
  }

  private generateTraceId(): string {
    return `trace_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
