import type { IProtocolAdapter, ProtocolAdapterConfig } from './protocol-detector.js';

// Use the pipeline converter to perform robust mapping between OpenAI and Anthropic
export class OpenAIAdapter implements IProtocolAdapter {
  private readonly config: ProtocolAdapterConfig;

  constructor(config: ProtocolAdapterConfig = {}) {
    this.config = {
      name: 'openai',
      version: '1.0.0',
      supportedEndpoints: ['/v1/chat/completions', '/v1/completions', '/v1/embeddings'],
      defaultHeaders: { 'Content-Type': 'application/json' },
      ...config
    };
  }

  detectRequest(request: unknown): boolean {
    if (!request || typeof request !== 'object') return false;
    const r = request as Record<string, unknown>;
    return Array.isArray(r.messages) || typeof r.prompt === 'string';
  }

  detectResponse(response: unknown): boolean {
    if (!response || typeof response !== 'object') return false;
    const r = response as Record<string, unknown>;
    return Array.isArray(r.choices) || r.object === 'list' || r.object === 'chat.completion';
  }

  normalizeRequest(request: unknown): unknown {
    if (!request || typeof request !== 'object') return {};
    const r = request as Record<string, unknown>;
    // Ensure assistant tool_calls use stringified args
    if (Array.isArray(r.messages)) {
      const msgs = (r.messages as any[]).map((m) => {
        if (m && m.role === 'assistant' && Array.isArray(m.tool_calls)) {
          const tcs = m.tool_calls.map((tc: any) => {
            if (tc && tc.function && typeof tc.function === 'object' && typeof tc.function.arguments !== 'string') {
              try { tc.function.arguments = JSON.stringify(tc.function.arguments); } catch { tc.function.arguments = String(tc.function.arguments); }
            }
            return tc;
          });
          return { ...m, tool_calls: tcs };
        }
        return m;
      });
      return { ...r, messages: msgs };
    }
    return { ...r };
  }

  normalizeResponse(response: unknown): unknown {
    if (!response || typeof response !== 'object') return {};
    return { ...(response as Record<string, unknown>) };
  }

  // Convert Anthropic → OpenAI (sourceProtocol='anthropic')
  convertFromProtocol(request: unknown, sourceProtocol: string): unknown {
    if (sourceProtocol !== 'anthropic') return this.normalizeRequest(request);
    try {
      const { AnthropicOpenAIConverter } = require('../../modules/pipeline/modules/llmswitch/llmswitch-anthropic-openai.js');
      const { PipelineDebugLogger } = require('../../modules/pipeline/utils/debug-logger.js');
      const logger = new PipelineDebugLogger(null, { enableConsoleLogging: false, enableDebugCenter: false });
      const deps = { errorHandlingCenter: {}, debugCenter: {}, logger } as any;
      const conv = new AnthropicOpenAIConverter({ type: 'llmswitch-anthropic-openai', config: {} }, deps);
      if (typeof conv.initialize === 'function') { (conv as any).initialize(); }
      // call private conversion via any to avoid heavy DTO wrapping
      return (conv as any).convertAnthropicRequestToOpenAI(request);
    } catch {
      return this.normalizeRequest(request);
    }
  }

  // Convert OpenAI → Anthropic (targetProtocol='anthropic')
  convertToProtocol(request: unknown, targetProtocol: string): unknown {
    if (targetProtocol !== 'anthropic') return this.normalizeRequest(request);
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
}
