/**
 * OpenAI Normalizer LLM Switch
 * Standardizes OpenAI requests to ensure proper format before processing.
 */

import type {
  LLMSwitchModule,
  ModuleConfig,
  ModuleDependencies
} from '../../interfaces/pipeline-interfaces.js';

/**
 * OpenAI Normalizer LLM Switch Module
 * Ensures OpenAI Chat Completions requests are properly formatted
 */
export class OpenAINormalizerLLMSwitch implements LLMSwitchModule {
  readonly id: string;
  readonly type = 'llmswitch-openai-openai';
  readonly config: ModuleConfig;
  readonly protocol = 'openai';
  private isInitialized = false;

  constructor(config: ModuleConfig, _dependencies: ModuleDependencies) {
    this.id = `llmswitch-openai-openai-${Date.now()}`;
    this.config = config;
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }
    this.isInitialized = true;
  }

  async processIncoming(request: any): Promise<any> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    const normalized = this.normalizeOpenAIRequest(request);

    return {
      ...normalized,
      _metadata: {
        switchType: 'llmswitch-openai-openai',
        timestamp: Date.now(),
        originalProtocol: 'openai',
        targetProtocol: 'openai'
      }
    };
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
    if (!request || typeof request !== 'object') {
      return request;
    }

    const normalized = { ...request };

    if (Array.isArray(normalized.messages)) {
      normalized.messages = normalized.messages.map((msg: any) => this.normalizeMessage(msg));
    }

    if (Array.isArray(normalized.tools)) {
      normalized.tools = normalized.tools.map((tool: any) => this.normalizeTool(tool));
    }

    return normalized;
  }

  private normalizeMessage(message: any): any {
    if (!message || typeof message !== 'object') {
      return message;
    }

    const normalizedMessage = { ...message };

    if (normalizedMessage.content === undefined || normalizedMessage.content === null) {
      normalizedMessage.content = '';
    } else if (typeof normalizedMessage.content === 'string') {
      // already string, nothing to do
    } else if (Array.isArray(normalizedMessage.content)) {
      // structured content, preserve as-is
    } else if (typeof normalizedMessage.content === 'object') {
      // keep structured object payloads intact
    } else {
      normalizedMessage.content = String(normalizedMessage.content);
    }

    if (
      normalizedMessage.role === 'assistant' &&
      Array.isArray(normalizedMessage.tool_calls)
    ) {
      normalizedMessage.tool_calls = normalizedMessage.tool_calls.map((toolCall: any) => {
        if (!toolCall || typeof toolCall !== 'object') {
          return toolCall;
        }

        const normalizedToolCall = { ...toolCall };
        if (
          normalizedToolCall.function &&
          typeof normalizedToolCall.function === 'object'
        ) {
          const fn = { ...normalizedToolCall.function };
          if (fn.arguments !== undefined && typeof fn.arguments !== 'string') {
            try {
              fn.arguments = JSON.stringify(fn.arguments);
            } catch {
              fn.arguments = String(fn.arguments);
            }
          }
          normalizedToolCall.function = fn;
        }
        return normalizedToolCall;
      });
    }

    return normalizedMessage;
  }

  private normalizeTool(tool: any): any {
    if (!tool || typeof tool !== 'object') {
      return tool;
    }

    const normalizedTool = { ...tool };

    if (normalizedTool.type === 'function' && normalizedTool.function) {
      const fn = { ...normalizedTool.function };
      if (fn.parameters && typeof fn.parameters !== 'object') {
        try {
          fn.parameters = JSON.parse(String(fn.parameters));
        } catch {
          fn.parameters = {};
        }
      }
      normalizedTool.function = fn;
    }

    return normalizedTool;
  }

  async dispose(): Promise<void> {
    this.isInitialized = false;
  }

  async cleanup(): Promise<void> {
    await this.dispose();
  }

  getStats(): any {
    return {
      type: this.type,
      initialized: this.isInitialized,
      timestamp: Date.now()
    };
  }
}

