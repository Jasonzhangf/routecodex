/**
 * 可插拔接收器层
 * 基于设计文档 docs/ROUNDTRIP_TEST_DESIGN.md:296-350
 */

export interface ReceiverConfig {
  type: 'lmstudio' | 'stub' | 'custom';
  endpoint?: string;
  apiKey?: string;
  timeoutMs?: number;
  retryCount?: number;
  debugMode?: boolean;
  customHandler?: (request: any) => Promise<any>;
}

export interface ReceiverCapabilities {
  supportsStreaming: boolean;
  supportedProtocols: ('responses' | 'chat')[];
  supportedTools: string[];
  maxTokens?: number;
  supportsReasoning?: boolean;
}

export interface RequestData {
  id: string;
  protocol: 'responses' | 'chat';
  payload: any;
  headers: Record<string, string>;
  timestamp: number;
}

export interface ResponseData {
  id: string;
  status: number;
  headers: Record<string, string>;
  payload: any;
  chunks?: any[]; // 流式响应
  timestamp: number;
  processingTime: number;
}

/**
 * 接收器接口
 */
export interface Receiver {
  readonly config: ReceiverConfig;
  readonly capabilities: ReceiverCapabilities;

  initialize(): Promise<void>;
  process(request: RequestData): Promise<ResponseData>;
  processStreaming(request: RequestData): Promise<ResponseData>;
  healthCheck(): Promise<boolean>;
  cleanup(): Promise<void>;
}

/**
 * LM Studio接收器
 */
export class LMStudioReceiver implements Receiver {
  readonly config: ReceiverConfig;
  readonly capabilities: ReceiverCapabilities;

  constructor(config: ReceiverConfig) {
    this.config = { ...config, type: 'lmstudio' };
    this.capabilities = {
      supportsStreaming: true,
      supportedProtocols: ['responses', 'chat'],
      supportedTools: ['get_current_time', 'get_weather', 'calculate'],
      maxTokens: 262144,
      supportsReasoning: true
    };
  }

  async initialize(): Promise<void> {
    if (this.config.debugMode) {
      console.log(`[LMStudioReceiver] Initializing with endpoint: ${this.config.endpoint}`);
    }

    // 验证连接
    const isHealthy = await this.healthCheck();
    if (!isHealthy) {
      throw new Error(`LM Studio receiver not reachable at ${this.config.endpoint}`);
    }

    if (this.config.debugMode) {
      console.log(`[LMStudioReceiver] Initialization complete`);
    }
  }

  async process(request: RequestData): Promise<ResponseData> {
    const startTime = Date.now();

    try {
      const response = await this.sendRequest(request, false);

      return {
        id: request.id,
        status: response.status,
        headers: response.headers,
        payload: response.body,
        timestamp: Date.now(),
        processingTime: Date.now() - startTime
      };
    } catch (error) {
      throw new Error(`LM Studio processing failed: ${getErrorMessage(error)}`);
    }
  }

  async processStreaming(request: RequestData): Promise<ResponseData> {
    const startTime = Date.now();

    try {
      const response = await this.sendRequest(request, true);

      return {
        id: request.id,
        status: response.status,
        headers: response.headers,
        payload: response.body,
        chunks: response.chunks,
        timestamp: Date.now(),
        processingTime: Date.now() - startTime
      };
    } catch (error) {
      throw new Error(`LM Studio streaming failed: ${getErrorMessage(error)}`);
    }
  }

  async healthCheck(): Promise<boolean> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    try {
      const healthUrl = `${this.config.endpoint}/health`;
      const response = await fetch(healthUrl, {
        method: 'GET',
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      return response.ok;
    } catch (error) {
      clearTimeout(timeoutId);
      if (this.config.debugMode) {
        console.log(`[LMStudioReceiver] Health check failed: ${getErrorMessage(error)}`);
      }
      return false;
    }
  }

  async cleanup(): Promise<void> {
    if (this.config.debugMode) {
      console.log(`[LMStudioReceiver] Cleanup complete`);
    }
  }

  private async sendRequest(request: RequestData, streaming: boolean): Promise<any> {
    const url = `${this.config.endpoint}/${this.getEndpointForProtocol(request.protocol)}`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.config.apiKey ?? ''}`,
      ...request.headers
    };

    if (streaming) {
      headers['Accept'] = 'text/event-stream';
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeoutMs || 30000);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(request.payload),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      if (streaming && response.headers.get('content-type')?.includes('text/event-stream')) {
        // 处理流式响应
        const chunks: any[] = [];
        const reader = response.body?.getReader();
        const decoder = new TextDecoder();

        if (reader) {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            const parsedChunks = this.parseSSEChunk(chunk);
            chunks.push(...parsedChunks);
          }
        }

        return {
          status: response.status,
          headers: responseHeaders,
          body: { message: 'Streaming completed', chunkCount: chunks.length },
          chunks
        };
      } else {
        // 处理常规响应
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
      }
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Request timeout after ${this.config.timeoutMs}ms`);
      }
      throw error instanceof Error ? error : new Error(getErrorMessage(error));
    }
  }

  private getEndpointForProtocol(protocol: 'responses' | 'chat'): string {
    switch (protocol) {
      case 'responses':
        return 'v1/messages';
      case 'chat':
        return 'v1/chat/completions';
      default:
        throw new Error(`Unsupported protocol: ${protocol}`);
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
          if (Object.keys(currentEvent).length > 0) {
            chunks.push(currentEvent);
            currentEvent = {};
          }
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
      } else if (line.trim() === '') {
        if (Object.keys(currentEvent).length > 0) {
          chunks.push(currentEvent);
          currentEvent = {};
        }
      }
    }

    return chunks;
  }
}

/**
 * Stub接收器 - 用于测试
 */
export class StubReceiver implements Receiver {
  readonly config: ReceiverConfig;
  readonly capabilities: ReceiverCapabilities;

  private responseStore: Map<string, any> = new Map();

  constructor(config: ReceiverConfig) {
    this.config = { ...config, type: 'stub' };
    this.capabilities = {
      supportsStreaming: true,
      supportedProtocols: ['responses', 'chat'],
      supportedTools: ['*'], // 支持所有工具
      maxTokens: 100000,
      supportsReasoning: true
    };
  }

  async initialize(): Promise<void> {
    if (this.config.debugMode) {
      console.log(`[StubReceiver] Initialized`);
    }
  }

  async process(request: RequestData): Promise<ResponseData> {
    const startTime = Date.now();
    await this.simulateDelay();

    // 生成模拟响应
    const payload = this.generateMockResponse(request, false);

    return {
      id: request.id,
      status: 200,
      headers: { 'content-type': 'application/json' },
      payload,
      timestamp: Date.now(),
      processingTime: Date.now() - startTime
    };
  }

  async processStreaming(request: RequestData): Promise<ResponseData> {
    const startTime = Date.now();
    await this.simulateDelay();

    // 生成模拟流式响应
    const { payload, chunks } = this.generateMockResponse(request, true);

    return {
      id: request.id,
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      payload,
      chunks,
      timestamp: Date.now(),
      processingTime: Date.now() - startTime
    };
  }

  async healthCheck(): Promise<boolean> {
    return true; // Stub总是健康的
  }

  async cleanup(): Promise<void> {
    this.responseStore.clear();
    if (this.config.debugMode) {
      console.log(`[StubReceiver] Cleanup complete`);
    }
  }

  /**
   * 设置预设响应用于测试
   */
  setMockResponse(requestId: string, response: any): void {
    this.responseStore.set(requestId, response);
  }

  private async simulateDelay(): Promise<void> {
    // 模拟网络延迟
    const delay = 50 + Math.random() * 100;
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  private generateMockResponse(request: RequestData, streaming: boolean): { payload: any; chunks?: any[] } {
    // 检查是否有预设响应
    if (this.responseStore.has(request.id)) {
      return { payload: this.responseStore.get(request.id) };
    }

    // 生成通用模拟响应
    const baseResponse = {
      id: `resp_${request.id}`,
      object: request.protocol === 'responses' ? 'response' : 'chat.completion',
      created_at: Date.now(),
      model: 'mock-model',
      status: 'completed'
    };

    if (request.protocol === 'responses') {
      const responsesPayload = {
        ...baseResponse,
        output: [{
          id: `msg_${request.id}`,
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{
            type: 'output_text',
            text: `Mock response for request ${request.id}`
          }]
        }],
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          total_tokens: 30
        }
      };

      if (streaming) {
        // 生成流式chunks
        const chunks = this.generateMockStreamingChunks(request, responsesPayload);
        return {
          payload: { message: 'Streaming completed', chunks: chunks.length },
          chunks
        };
      }

      return { payload: responsesPayload };
    } else {
      // Chat格式响应
      const chatPayload = {
        ...baseResponse,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: `Mock chat response for request ${request.id}`
          },
          finish_reason: 'stop'
        }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 20,
          total_tokens: 30
        }
      };

      if (streaming) {
        const chunks = this.generateMockChatStreamingChunks(request, chatPayload);
        return {
          payload: { message: 'Streaming completed', chunks: chunks.length },
          chunks
        };
      }

      return { payload: chatPayload };
    }
  }

  private generateMockStreamingChunks(request: RequestData, finalPayload: any): any[] {
    const chunks: any[] = [];
    const text = finalPayload.output[0].content[0].text;
    const words = text.split(' ');
    let currentText = '';

    // 创建事件
    chunks.push({
      event: 'response.created',
      data: {
        response_id: `resp_${request.id}`,
        object: 'response',
        created_at: Date.now()
      }
    });

    chunks.push({
      event: 'response.in_progress',
      data: {
        response_id: `resp_${request.id}`,
        status: 'in_progress'
      }
    });

    // 逐词发送
    for (let i = 0; i < words.length; i++) {
      currentText += (i > 0 ? ' ' : '') + words[i];

      chunks.push({
        event: 'response.output_text.delta',
        data: {
          output_index: 0,
          item_id: `msg_${request.id}`,
          content_index: 0,
          delta: (i > 0 ? ' ' : '') + words[i]
        }
      });
    }

    // 完成事件
    chunks.push({
      event: 'response.output_text.done',
      data: {
        output_index: 0,
        item_id: `msg_${request.id}`,
        content_index: 0
      }
    });

    chunks.push({
      event: 'response.completed',
      data: finalPayload
    });

    chunks.push({
      event: 'response.done',
      data: {}
    });

    return chunks;
  }

  private generateMockChatStreamingChunks(request: RequestData, finalPayload: any): any[] {
    const chunks: any[] = [];
    const text = finalPayload.choices[0].message.content;
    const words = text.split(' ');
    let currentText = '';

    // 逐词发送
    for (let i = 0; i < words.length; i++) {
      currentText += (i > 0 ? ' ' : '') + words[i];

      chunks.push({
        id: `chunk_${i}`,
        object: 'chat.completion.chunk',
        created: Date.now(),
        model: 'mock-model',
        choices: [{
          index: 0,
          delta: {
            content: (i > 0 ? ' ' : '') + words[i]
          },
          finish_reason: null
        }]
      });
    }

    // 最终chunk
    chunks.push({
      id: `chunk_final`,
      object: 'chat.completion.chunk',
      created: Date.now(),
      model: 'mock-model',
      choices: [{
        index: 0,
        delta: {},
        finish_reason: 'stop'
      }]
    });

    return chunks;
  }
}

/**
 * 自定义接收器
 */
export class CustomReceiver implements Receiver {
  readonly config: ReceiverConfig;
  readonly capabilities: ReceiverCapabilities;

  constructor(config: ReceiverConfig) {
    this.config = { ...config, type: 'custom' };
    this.capabilities = {
      supportsStreaming: true,
      supportedProtocols: ['responses', 'chat'],
      supportedTools: ['*'],
      supportsReasoning: true
    };

    if (!config.customHandler) {
      throw new Error('Custom receiver requires customHandler function');
    }
  }

  async initialize(): Promise<void> {
    if (this.config.debugMode) {
      console.log(`[CustomReceiver] Initialized`);
    }
  }

  async process(request: RequestData): Promise<ResponseData> {
    const startTime = Date.now();

    try {
      const response = await this.config.customHandler!(request.payload);

      return {
        id: request.id,
        status: 200,
        headers: { 'content-type': 'application/json' },
        payload: response,
        timestamp: Date.now(),
        processingTime: Date.now() - startTime
      };
    } catch (error) {
      throw new Error(`Custom receiver processing failed: ${getErrorMessage(error)}`);
    }
  }

  async processStreaming(request: RequestData): Promise<ResponseData> {
    // 自定义接收器的流式处理需要通过customHandler实现
    throw new Error('Custom receiver streaming not implemented - use customHandler directly');
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }

  async cleanup(): Promise<void> {
    if (this.config.debugMode) {
      console.log(`[CustomReceiver] Cleanup complete`);
    }
  }
}

/**
 * 接收器工厂
 */
export class ReceiverFactory {
  static create(config: ReceiverConfig): Receiver {
    switch (config.type) {
      case 'lmstudio':
        return new LMStudioReceiver(config);
      case 'stub':
        return new StubReceiver(config);
      case 'custom':
        return new CustomReceiver(config);
      default:
        throw new Error(`Unknown receiver type: ${config.type}`);
    }
  }

  static createLMStudio(endpoint: string, apiKey: string, options: Partial<ReceiverConfig> = {}): LMStudioReceiver {
    return new LMStudioReceiver({
      type: 'lmstudio',
      endpoint,
      apiKey,
      ...options
    });
  }

  static createStub(options: Partial<ReceiverConfig> = {}): StubReceiver {
    return new StubReceiver({
      type: 'stub',
      ...options
    });
  }

  static createCustom(handler: (request: any) => Promise<any>, options: Partial<ReceiverConfig> = {}): CustomReceiver {
    return new CustomReceiver({
      type: 'custom',
      customHandler: handler,
      ...options
    });
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
