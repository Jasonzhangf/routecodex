/**
 * OpenAI Normalizer LLM Switch
 * Standardizes OpenAI requests to ensure proper format before processing.
 */

import type { LLMSwitchModule, ModuleConfig, ModuleDependencies } from '../../interfaces/pipeline-interfaces.js';
import type { SharedPipelineRequest } from '../../../../types/shared-dtos.js';

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

  async processIncoming(requestParam: any): Promise<SharedPipelineRequest> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    const isDto = requestParam && typeof requestParam === 'object' && 'data' in requestParam && 'route' in requestParam;
    const dto = isDto ? (requestParam as SharedPipelineRequest) : null;
    const payload = isDto ? (dto!.data as any) : (requestParam as any);

    const normalized = this.normalizeOpenAIRequest(payload);

    const outDto: SharedPipelineRequest = isDto
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
    // Accept either raw payload or DTO { data, metadata }
    const isDto = response && typeof response === 'object' && 'data' in response && 'metadata' in response;
    const payload = isDto ? (response as any).data : response;
    const normalized = this.normalizeOpenAIResponse(payload);
    if (isDto) {
      return { ...(response as any), data: normalized };
    }
    return normalized;
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

  private normalizeOpenAIResponse(res: any): any {
    if (!res || typeof res !== 'object') {
      return res;
    }
    const out = { ...res };
    if (Array.isArray(out.choices)) {
      out.choices = out.choices.map((c: any) => {
        const choice = { ...c };
        const msg = choice.message && typeof choice.message === 'object' ? { ...choice.message } : choice.message;
        if (msg && typeof msg === 'object') {
          // Ensure tool_calls arguments are stringified and content empty when tool_calls exist
          if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
            msg.tool_calls = msg.tool_calls.map((tc: any) => {
              if (!tc || typeof tc !== 'object') return tc;
              const t = { ...tc };
              if (t.function && typeof t.function === 'object') {
                const fn = { ...t.function };
                if (fn.arguments !== undefined && typeof fn.arguments !== 'string') {
                  try { fn.arguments = JSON.stringify(fn.arguments); } catch { fn.arguments = String(fn.arguments); }
                }
                t.function = fn;
              }
              return t;
            });
            // OpenAI expects content to be a string when tool_calls are present; set to empty string
            msg.content = typeof msg.content === 'string' ? msg.content : '';
          } else if (Array.isArray(msg.content)) {
            // If providers returned array content (non-standard for chat.completions),
            // join textual parts into a single string for compatibility
            const parts = msg.content
              .map((p: any) => (typeof p === 'string' ? p : (p && typeof p.text === 'string' ? p.text : '')))
              .filter((s: string) => !!s.trim());
            msg.content = parts.join('\n');
          } else if (msg.content === undefined || msg.content === null) {
            msg.content = '';
          }
          choice.message = msg;
        }
        return choice;
      });
    }
    return out;
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
