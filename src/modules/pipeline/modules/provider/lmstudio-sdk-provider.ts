/**
 * LM Studio SDK Provider Implementation
 *
 * Uses @lmstudio/sdk to run local models. This provider adapts
 * OpenAI-like requests (model + messages/prompt) to LM Studio SDK calls.
 */

import type { ProviderModule, ModuleConfig, ModuleDependencies } from '../../interfaces/pipeline-interfaces.js';
import type { ProviderResponse, ProviderError } from '../../types/provider-types.js';
import { PipelineDebugLogger } from '../../utils/debug-logger.js';

export class LMStudioSDKProvider implements ProviderModule {
  readonly id: string;
  readonly type = 'lmstudio-sdk';
  readonly providerType = 'lmstudio';
  readonly config: ModuleConfig;

  private isInitialized = false;
  private logger: PipelineDebugLogger;
  private client: any = null; // LMStudioClient

  constructor(config: ModuleConfig, private dependencies: ModuleDependencies) {
    this.id = `provider-${Date.now()}`;
    this.config = config;
    this.logger = dependencies.logger as any;
  }

  async initialize(): Promise<void> {
    try {
      this.logger.logModule(this.id, 'initializing', { config: this.config, providerType: this.providerType });

      const { LMStudioClient } = await import('@lmstudio/sdk');
      const baseUrl = this.config?.config?.baseUrl;
      this.client = baseUrl ? new LMStudioClient({ baseUrl }) : new LMStudioClient();

      this.isInitialized = true;
      this.logger.logModule(this.id, 'initialized');
    } catch (error) {
      this.logger.logModule(this.id, 'initialization-error', { error });
      throw error;
    }
  }

  async processIncoming(request: any): Promise<any> {
    if (!this.isInitialized) throw new Error('LM Studio SDK Provider is not initialized');

    try {
      const modelName: string = this.config?.config?.model || 'unknown';
      const messages = request.messages;
      const history = this.mapOpenAIToChat(messages, request);

      this.logger.logProviderRequest(this.id, 'request-start', { provider: 'lmstudio', model: modelName, hasTools: Array.isArray(request.tools) && request.tools.length>0 });

      const model = await this.client.llm.model(modelName);

      const maxTokens = typeof this.config?.config?.maxTokens === 'number' ? this.config.config.maxTokens : undefined;
      let data: any;
      if (Array.isArray(request.tools) && request.tools.length > 0) {
        // Convert OpenAI tool definitions to unimplementedRawFunctionTool so model can request tools
        const tools = await this.mapOpenAIToolsToLMSTools(request.tools);
        const toolRequests: Array<{ id?: string; name: string; arguments?: Record<string, any> }> = [];

        // Use act() to allow the model to request tool calls; stop gracefully on unimplemented
        await model.act(history, tools, {
          maxPredictionRounds: 1,
          ...(maxTokens !== undefined ? { maxTokens } : {}),
          // capture tool call requests
          onToolCallRequestEnd: (_roundIndex: number, _callId: number, info: { toolCallRequest: any; isQueued: boolean }) => {
            const req = info?.toolCallRequest;
            if (req && req.type === 'function') {
              toolRequests.push({ id: req.id, name: req.name, arguments: req.arguments });
            }
          }
        });

        data = this.wrapToolCallsOpenAIResponse(modelName, toolRequests);
      } else {
        // Basic non-streaming text generation
        const result = await model.respond(history, ...(maxTokens !== undefined ? [{ maxTokens }] : [{}]));
        data = this.wrapToOpenAIChatResponse(modelName, result);
      }

      const response: ProviderResponse = {
        data,
        status: 200,
        headers: { 'content-type': 'application/json' },
        metadata: {
          requestId: `req-${Date.now()}`,
          model: modelName
        }
      } as any;

      this.logger.logProviderRequest(this.id, 'request-success', { status: response.status });
      return response;
    } catch (error) {
      const providerError = this.createProviderError(error, 'sdk');
      this.logger.logModule(this.id, 'provider-error', { error: providerError });
      await this.dependencies.errorHandlingCenter.handleError({
        type: 'provider-error',
        message: providerError.message,
        details: { providerId: this.id, error: providerError },
        timestamp: Date.now()
      });
      throw providerError;
    }
  }

  async processOutgoing(response: any): Promise<any> {
    return response;
  }

  async sendRequest(request: any): Promise<ProviderResponse> {
    return this.processIncoming(request);
  }

  async checkHealth(): Promise<boolean> {
    try {
      // Simple health check: ensure client exists
      const ok = !!this.client;
      this.logger.logModule(this.id, 'health-check', { status: ok ? 'healthy' : 'unhealthy' });
      return ok;
    } catch {
      return false;
    }
  }

  async cleanup(): Promise<void> {
    this.isInitialized = false;
    this.client = null;
  }

  // Helpers
  private mapOpenAIToChat(messages: any[], request: any): any[] {
    if (!Array.isArray(messages)) return [];
    return messages.map((m) => {
      let content = '';
      if (typeof m.content === 'string') content = m.content;
      else if (Array.isArray(m.content)) {
        // concatenate parts for now
        content = m.content.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join('\n');
      } else content = JSON.stringify(m.content || '');
      return { role: m.role || 'user', content };
    });
  }

  private wrapToOpenAIChatResponse(model: string, result: any) {
    const content = typeof result === 'string' ? result : (result?.content ?? JSON.stringify(result));
    return {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content },
          finish_reason: 'stop'
        }
      ]
    };
  }

  private wrapToolCallsOpenAIResponse(model: string, toolRequests: Array<{ id?: string; name: string; arguments?: Record<string, any> }>) {
    const tool_calls = toolRequests.map((tr, idx) => ({
      id: tr.id || `call_${Date.now()}_${idx}`,
      type: 'function',
      function: {
        name: tr.name,
        arguments: JSON.stringify(tr.arguments ?? {})
      }
    }));
    return {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: '', tool_calls },
          finish_reason: 'tool_calls'
        }
      ]
    };
  }

  private async mapOpenAIToolsToLMSTools(openaiTools: any[]): Promise<any[]> {
    const { unimplementedRawFunctionTool } = await import('@lmstudio/sdk');
    return openaiTools
      .filter(t => t?.type === 'function' && t.function && t.function.name)
      .map(t => {
        const fn = t.function;
        const parametersJsonSchema = fn.parameters && typeof fn.parameters === 'object' ? fn.parameters : { type: 'object', properties: {} };
        return unimplementedRawFunctionTool({
          name: fn.name,
          description: fn.description || 'unimplemented tool',
          parametersJsonSchema
        });
      });
  }

  private createProviderError(error: unknown, type: string): ProviderError {
    const errorObj = error instanceof Error ? error : new Error(String(error));
    const providerError: ProviderError = new Error(errorObj.message) as ProviderError;
    providerError.type = type as any;
    providerError.statusCode = (error as any)?.status || (error as any)?.statusCode;
    providerError.details = (error as any)?.details || error;
    providerError.retryable = false;
    return providerError;
  }
}
