import type { IProtocolAdapter, ProtocolAdapterConfig } from './protocol-detector.js';

export class AnthropicAdapter implements IProtocolAdapter {
  private readonly config: ProtocolAdapterConfig;

  constructor(config: ProtocolAdapterConfig = {}) {
    this.config = {
      name: 'anthropic',
      version: '1.0.0',
      supportedEndpoints: ['/v1/messages', '/v1/responses'],
      defaultHeaders: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
      ...config
    };
  }

  detectRequest(request: unknown): boolean {
    if (!request || typeof request !== 'object') return false;
    const r = request as Record<string, unknown>;
    return typeof r.system === 'string' || (Array.isArray(r.messages) && this.isAnthropicMessageArray(r.messages as any[]));
  }

  detectResponse(response: unknown): boolean {
    if (!response || typeof response !== 'object') return false;
    const r = response as Record<string, unknown>;
    return r.type === 'message' || Array.isArray(r.content);
  }

  normalizeRequest(request: unknown): unknown {
    if (!request || typeof request !== 'object') return {};
    return { ...(request as Record<string, unknown>) };
  }

  normalizeResponse(response: unknown): unknown {
    if (!response || typeof response !== 'object') return {};
    return { ...(response as Record<string, unknown>) };
  }

  // Convert OpenAI → Anthropic
  convertFromProtocol(request: unknown, sourceProtocol: string): unknown {
    if (sourceProtocol !== 'openai') return this.normalizeRequest(request);
    try {
      const { AnthropicOpenAIConverter } = require('../../modules/pipeline/modules/llmswitch/llmswitch-anthropic-openai.js');
      const { PipelineDebugLogger } = require('../../modules/pipeline/utils/debug-logger.js');
      const logger = new PipelineDebugLogger(null, { enableConsoleLogging: false, enableDebugCenter: false });
      const deps = { errorHandlingCenter: {}, debugCenter: {}, logger } as any;
      const conv = new AnthropicOpenAIConverter({ type: 'llmswitch-anthropic-openai', config: {} }, deps);
      if (typeof conv.initialize === 'function') { (conv as any).initialize(); }
      return (conv as any).convertOpenAIRequestToAnthropic(request);
    } catch {
      return this.normalizeRequest(request);
    }
  }

  // Convert Anthropic → OpenAI
  convertToProtocol(request: unknown, targetProtocol: string): unknown {
    if (targetProtocol !== 'openai') return this.normalizeRequest(request);
    try {
      const { AnthropicOpenAIConverter } = require('../../modules/pipeline/modules/llmswitch/llmswitch-anthropic-openai.js');
      const { PipelineDebugLogger } = require('../../modules/pipeline/utils/debug-logger.js');
      const logger = new PipelineDebugLogger(null, { enableConsoleLogging: false, enableDebugCenter: false });
      const deps = { errorHandlingCenter: {}, debugCenter: {}, logger } as any;
      const conv = new AnthropicOpenAIConverter({ type: 'llmswitch-anthropic-openai', config: {} }, deps);
      if (typeof conv.initialize === 'function') { (conv as any).initialize(); }
      return (conv as any).convertAnthropicRequestToOpenAI(request);
    } catch {
      return this.normalizeRequest(request);
    }
  }

  private isAnthropicMessageArray(messages: any[]): boolean {
    return messages.some((m) => m && Array.isArray(m.content));
  }
}
