/**
 * OpenAI Normalizer LLM Switch (sharedmodule wrapper)
 * Logic copied from root module; types relaxed to avoid root coupling.
 */

export class OpenAINormalizerLLMSwitch {
  readonly id: string;
  readonly type = 'llmswitch-openai-openai';
  readonly protocol = 'openai';
  readonly config: any;
  private isInitialized = false;

  constructor(config: any, _dependencies: any) {
    this.id = `llmswitch-openai-openai-${Date.now()}`;
    this.config = config;
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) return;
    this.isInitialized = true;
  }

  async processIncoming(requestParam: any): Promise<any> {
    if (!this.isInitialized) await this.initialize();
    const isDto = requestParam && typeof requestParam === 'object' && 'data' in requestParam && 'route' in requestParam;
    const dto = isDto ? (requestParam as any) : null;
    const payload = isDto ? (dto!.data as any) : (requestParam as any);

    const normalized = this.normalizeOpenAIRequest(payload);

    const outDto = isDto
      ? { ...dto!, data: { ...normalized, _metadata: { switchType: 'llmswitch-openai-openai', timestamp: Date.now(), originalProtocol: 'openai', targetProtocol: 'openai' } } }
      : {
          data: { ...normalized, _metadata: { switchType: 'llmswitch-openai-openai', timestamp: Date.now(), originalProtocol: 'openai', targetProtocol: 'openai' } },
          route: { providerId: 'unknown', modelId: 'unknown', requestId: 'unknown', timestamp: Date.now() },
          metadata: {},
          debug: { enabled: false, stages: {} }
        };
    return outDto;
  }

  async processOutgoing(response: any): Promise<any> {
    return response;
  }

  async transformRequest(request: any): Promise<any> {
    return this.processIncoming(request);
  }

  async transformResponse(response: any): Promise<any> {
    return response;
  }

  private normalizeOpenAIRequest(request: any): any {
    if (!request || typeof request !== 'object') return request;
    const normalized: any = { ...request };

    if (Array.isArray(normalized.messages)) {
      normalized.messages = normalized.messages.map((msg: any) => this.normalizeMessage(msg));
    }
    if (Array.isArray(normalized.tools)) {
      normalized.tools = normalized.tools.map((tool: any) => this.normalizeTool(tool));
    }
    return normalized;
  }

  private normalizeMessage(message: any): any {
    if (!message || typeof message !== 'object') return message;
    const normalizedMessage: any = { ...message };

    // 保持原样：content 允许为 undefined/null（例如 assistant 命中 tool_calls 的场景）
    if (typeof normalizedMessage.content === 'string') {
      // ok
    } else if (Array.isArray(normalizedMessage.content)) {
      // structured content allowed
    } else if (typeof normalizedMessage.content === 'object') {
      // keep object
    } else {
      // 对非字符串的基本类型做字符串化；undefined/null 保持原样
      if (normalizedMessage.content !== undefined && normalizedMessage.content !== null) {
        normalizedMessage.content = String(normalizedMessage.content);
      }
    }

    if (normalizedMessage.role === 'assistant' && Array.isArray(normalizedMessage.tool_calls)) {
      normalizedMessage.tool_calls = normalizedMessage.tool_calls.map((toolCall: any) => {
        if (!toolCall || typeof toolCall !== 'object') return toolCall;
        const normalizedToolCall: any = { ...toolCall };
        if (normalizedToolCall.function && typeof normalizedToolCall.function === 'object') {
          const fn: any = { ...normalizedToolCall.function };
          if (fn.arguments !== undefined && typeof fn.arguments !== 'string') {
            try { fn.arguments = JSON.stringify(fn.arguments); } catch { fn.arguments = String(fn.arguments); }
          }
          normalizedToolCall.function = fn;
        }
        return normalizedToolCall;
      });
    }
    return normalizedMessage;
  }

  private normalizeTool(tool: any): any {
    if (!tool || typeof tool !== 'object') return tool;
    const normalizedTool: any = { ...tool };
    if (normalizedTool.type === 'function' && normalizedTool.function) {
      const fn: any = { ...normalizedTool.function };
      if (fn.parameters && typeof fn.parameters !== 'object') {
        try { fn.parameters = JSON.parse(String(fn.parameters)); } catch { fn.parameters = {}; }
      }
      normalizedTool.function = fn;
    }
    return normalizedTool;
  }

  async dispose(): Promise<void> { this.isInitialized = false; }
  async cleanup(): Promise<void> { await this.dispose(); }
  getStats(): any { return { type: this.type, initialized: this.isInitialized, timestamp: Date.now() }; }
}
