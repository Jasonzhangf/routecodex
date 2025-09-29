/**
 * Anthropic ↔ OpenAI LLMSwitch 实现
 * 基于配置驱动的双向协议转换
 */

import type { LLMSwitchModule, ModuleConfig, ModuleDependencies } from '../../interfaces/pipeline-interfaces.js';
import { PipelineDebugLogger } from '../../utils/debug-logger.js';
import {
  DEFAULT_CONVERSION_CONFIG,
  detectRequestFormat,
  detectResponseFormat,
  type ConversionConfig
} from './anthropic-openai-config.js';

export class AnthropicOpenAIConverter implements LLMSwitchModule {
  readonly id: string;
  readonly type = 'llmswitch-anthropic-openai';
  readonly protocol = 'bidirectional';
  readonly config: ModuleConfig;

  private isInitialized = false;
  private logger: PipelineDebugLogger;
  private conversionConfig: ConversionConfig;
  private enableStreaming: boolean;
  private enableTools: boolean;

  constructor(config: ModuleConfig, private dependencies: ModuleDependencies) {
    this.config = config;
    this.id = `llmswitch-anthropic-openai-${Date.now()}`;
    this.logger = dependencies.logger as any;
    this.conversionConfig = { ...DEFAULT_CONVERSION_CONFIG, ...(config.config?.conversionMappings || {}) };
    this.enableStreaming = config.config?.enableStreaming ?? true;
    this.enableTools = config.config?.enableTools ?? true;
  }

  async initialize(): Promise<void> {
    this.logger.logModule(this.id, 'config-validation-success', {
      enableStreaming: this.enableStreaming,
      enableTools: this.enableTools,
      hasRequestMappings: !!this.conversionConfig.requestMappings,
      hasResponseMappings: !!this.conversionConfig.responseMappings
    });
    this.isInitialized = true;
  }

  async processIncoming(request: any): Promise<any> {
    if (!this.isInitialized) {throw new Error('AnthropicOpenAIConverter is not initialized');}
    const requestFormat = detectRequestFormat(request);
    if (requestFormat === 'anthropic') {
      const transformedRequest = this.convertAnthropicRequestToOpenAI(request);
      this.logger.logTransformation(this.id, 'anthropic-to-openai-request', request, transformedRequest);
      return { ...transformedRequest, _metadata: { switchType: this.type, direction: 'anthropic-to-openai', timestamp: Date.now(), originalFormat: 'anthropic', targetFormat: 'openai' } };
    }
    return { ...request, _metadata: { switchType: this.type, direction: 'passthrough', timestamp: Date.now(), originalFormat: requestFormat, targetFormat: requestFormat } };
  }

  async processOutgoing(response: any): Promise<any> {
    if (!this.isInitialized) {throw new Error('AnthropicOpenAIConverter is not initialized');}
    const responseFormat = detectResponseFormat(response);
    if (responseFormat === 'openai') {
      const transformedResponse = this.convertOpenAIResponseToAnthropic(response);
      this.logger.logTransformation(this.id, 'openai-to-anthropic-response', response, transformedResponse);
      return { ...transformedResponse, _metadata: { ...response._metadata, switchType: this.type, direction: 'openai-to-anthropic', responseTimestamp: Date.now(), originalFormat: 'openai', targetFormat: 'anthropic' } };
    }
    return { ...response, _metadata: { ...response._metadata, switchType: this.type, direction: 'passthrough', responseTimestamp: Date.now(), originalFormat: responseFormat, targetFormat: responseFormat } };
  }

  async transformRequest(request: any): Promise<any> { return this.processIncoming(request); }
  async transformResponse(response: any): Promise<any> { return this.processOutgoing(response); }

  private convertAnthropicRequestToOpenAI(request: any): any {
    const { requestMappings } = this.conversionConfig;
    const transformed: any = {};
    if (request.system) {transformed.messages = [{ role: 'system', content: request.system }, ...(request.messages || [])];}
    else {transformed.messages = request.messages || [];}
    if (this.enableTools && request.tools) {transformed.tools = this.convertAnthropicToolsToOpenAI(request.tools);}
    this.copyParameters(request, transformed, requestMappings.parameters);
    return transformed;
  }

  private convertOpenAIResponseToAnthropic(response: any): any {
    const { responseMappings } = this.conversionConfig;
    const transformed: any = {};
    if (response.choices && response.choices.length > 0) {
      const choice = response.choices[0];
      const message = choice.message || {};
      transformed.role = message.role || 'assistant';
      if (message.content) {transformed.content = message.content;}
      if (this.enableTools && message.tool_calls) {transformed.content = this.convertOpenAIToolCallsToAnthropic(message.tool_calls);}
      if (choice.finish_reason) {transformed.stop_reason = responseMappings.finishReason.mapping[choice.finish_reason] || 'end_turn';}
    }
    if (response.usage) {transformed.usage = this.convertUsageStats(response.usage, (responseMappings as any).usage.fieldMapping);}
    if (response.id) {transformed.id = response.id;}
    if (response.model) {transformed.model = response.model;}
    if (response.created) {transformed.created = response.created;}
    return transformed;
  }

  private convertAnthropicToolsToOpenAI(tools: any[]): any[] {
    if (!tools) {return [];}
    return tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.input_schema } }));
  }

  private convertOpenAIToolCallsToAnthropic(toolCalls: any[]): any[] {
    if (!toolCalls) {return [];}
    return toolCalls.map(call => ({ type: 'tool_use', id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments || '{}') }));
  }

  private convertUsageStats(usage: any, fieldMapping: Record<string, string>): any {
    const transformed: any = {};
    for (const [sourceField, targetField] of Object.entries(fieldMapping)) {
      if (usage[sourceField] !== undefined) {transformed[targetField] = usage[sourceField];}
    }
    return transformed;
  }

  private copyParameters(source: any, target: any, parameterMappings: any): void {
    for (const mapping of Object.values(parameterMappings as any)) {
      const src = (mapping as any).source; const dst = (mapping as any).target;
      if (source[src] !== undefined) {target[dst] = source[src];}
    }
  }

  async cleanup(): Promise<void> { this.isInitialized = false; }
}

