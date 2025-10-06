/**
 * Anthropic ↔ OpenAI LLMSwitch 实现
 * 基于配置驱动的双向协议转换
 */

import type { LLMSwitchModule, ModuleConfig, ModuleDependencies } from '../../interfaces/pipeline-interfaces.js';
import type { SharedPipelineRequest, SharedPipelineResponse } from '../../../../types/shared-dtos.js';
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

  async processIncoming(requestParam: SharedPipelineRequest): Promise<SharedPipelineRequest> {
    if (!this.isInitialized) { throw new Error('AnthropicOpenAIConverter is not initialized'); }
    const isDto = requestParam && typeof requestParam === 'object' && 'data' in requestParam && 'route' in requestParam;
    const dto = isDto ? (requestParam as SharedPipelineRequest) : null;
    const payload = isDto ? (dto!.data as any) : (requestParam as unknown as any);
    const requestFormat = detectRequestFormat(payload);

    if (requestFormat === 'anthropic') {
      const transformedRequest = this.convertAnthropicRequestToOpenAI(payload);
      this.logger.logTransformation(this.id, 'anthropic-to-openai-request', payload, transformedRequest);
      const out = {
        ...transformedRequest,
        _metadata: {
          switchType: this.type,
          direction: 'anthropic-to-openai',
          timestamp: Date.now(),
          originalFormat: 'anthropic',
          targetFormat: 'openai'
        }
      } as Record<string, unknown>;
      return isDto
        ? { ...dto!, data: out }
        : ({ data: out, route: { providerId: 'unknown', modelId: 'unknown', requestId: 'unknown', timestamp: Date.now() }, metadata: {}, debug: { enabled: false, stages: {} } } as SharedPipelineRequest);
    }

    const passthrough = {
      ...payload,
      _metadata: {
        switchType: this.type,
        direction: 'passthrough',
        timestamp: Date.now(),
        originalFormat: requestFormat,
        targetFormat: requestFormat
      }
    } as Record<string, unknown>;
    return isDto
      ? { ...dto!, data: passthrough }
      : ({ data: passthrough, route: { providerId: 'unknown', modelId: 'unknown', requestId: 'unknown', timestamp: Date.now() }, metadata: {}, debug: { enabled: false, stages: {} } } as SharedPipelineRequest);
  }

  async processOutgoing(responseParam: SharedPipelineResponse | any): Promise<SharedPipelineResponse | any> {
    if (!this.isInitialized) { throw new Error('AnthropicOpenAIConverter is not initialized'); }
    const isDto = responseParam && typeof responseParam === 'object' && 'data' in responseParam && 'metadata' in responseParam;
    let payload = isDto ? (responseParam as SharedPipelineResponse).data : responseParam;
    // Unwrap provider wrapper if present
    if (payload && typeof payload === 'object' && 'data' in (payload as Record<string, unknown>)) {
      const inner = (payload as Record<string, unknown>)['data'];
      if (inner && typeof inner === 'object' && (('choices' in (inner as Record<string, unknown>)) || ('content' in (inner as Record<string, unknown>)))) {
        payload = inner as unknown;
      }
    }
    const responseFormat = detectResponseFormat(payload);

    if (responseFormat === 'openai') {
      const transformedResponse = this.convertOpenAIResponseToAnthropic(payload);
      this.logger.logTransformation(this.id, 'openai-to-anthropic-response', payload, transformedResponse);
      const out = {
        ...transformedResponse,
        _metadata: {
          ...(payload?._metadata || {}),
          switchType: this.type,
          direction: 'openai-to-anthropic',
          responseTimestamp: Date.now(),
          originalFormat: 'openai',
          targetFormat: 'anthropic'
        }
      } as Record<string, unknown>;
      return isDto ? { ...(responseParam as SharedPipelineResponse), data: out } : out;
    }

    const passthrough = {
      ...payload,
      _metadata: {
        ...(payload?._metadata || {}),
        switchType: this.type,
        direction: 'passthrough',
        responseTimestamp: Date.now(),
        originalFormat: responseFormat,
        targetFormat: responseFormat
      }
    } as Record<string, unknown>;
    return isDto ? { ...(responseParam as SharedPipelineResponse), data: passthrough } : passthrough;
  }

  async transformRequest(input: any): Promise<any> {
    // If DTO, delegate to processIncoming to keep DTO shape
    const isDto = input && typeof input === 'object' && 'data' in input && 'route' in input;
    if (isDto) { return this.processIncoming(input as SharedPipelineRequest); }
    // Plain object: convert plain→plain
    let payload = input as any;
    if (payload && typeof payload === 'object' && 'data' in payload) {
      const inner = (payload as Record<string, unknown>)['data'];
      if (inner && typeof inner === 'object' && (('choices' in (inner as Record<string, unknown>)) || ('content' in (inner as Record<string, unknown>)))) {
        payload = inner as unknown;
      }
    }
    const requestFormat = detectRequestFormat(payload);
    if (requestFormat === 'anthropic') {
      const out = this.convertAnthropicRequestToOpenAI(payload);
      return out;
    }
    return payload;
  }

  async transformResponse(input: any): Promise<any> {
    // If DTO, delegate to processOutgoing to keep DTO shape
    const isDto = input && typeof input === 'object' && 'data' in input && 'metadata' in input;
    if (isDto) { return this.processOutgoing(input as SharedPipelineResponse); }
    // Plain object: convert plain→plain
    const payload = input as any;
    const responseFormat = detectResponseFormat(payload);
    if (responseFormat === 'openai') {
      const out = this.convertOpenAIResponseToAnthropic(payload);
      return out;
    }
    return payload;
  }

  private convertAnthropicRequestToOpenAI(request: any): any {
    const { requestMappings } = this.conversionConfig;
    const transformed: any = {};
    // Build OpenAI-style messages from Anthropic system + messages
    const msgs: any[] = [];
    if (request.system) {
      const sys = Array.isArray(request.system) ? request.system.map((s: any) => (typeof s === 'string' ? s : '')).join('\n') : String(request.system);
      if (sys && sys.length > 0) { msgs.push({ role: 'system', content: sys }); }
    }
    for (const m of (request.messages || [])) {
      const role = m.role || 'user';
      const blocks = Array.isArray(m.content)
        ? m.content
        : (typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : []);

      // Tool use -> OpenAI tool_calls on assistant message
      const toolUses = blocks.filter((b: any) => b && b.type === 'tool_use');
      if (role === 'assistant' && toolUses.length > 0) {
        const tool_calls = toolUses.map((t: any) => ({
          id: t.id || t.tool_use_id || `tool_${Math.random().toString(36).slice(2)}`,
          type: 'function',
          function: {
            name: t.name || 'tool',
            arguments: typeof t.input === 'string' ? t.input : safeStringify(t.input || {})
          }
        }));
        // Optional assistant text blocks alongside tool calls
        const text = blocks
          .filter((b: any) => b && b.type === 'text' && typeof b.text === 'string')
          .map((b: any) => b.text)
          .join('\n');
        msgs.push({ role: 'assistant', content: text || '', tool_calls });
        continue;
      }

      // Tool result -> OpenAI tool role message
      const toolResults = blocks.filter((b: any) => b && b.type === 'tool_result');
      if (toolResults.length > 0) {
        for (const tr of toolResults) {
          const content = typeof tr.content === 'string' ? tr.content : safeStringify(tr.content || {});
          msgs.push({ role: 'tool', content, tool_call_id: tr.tool_use_id || tr.id || '' });
        }
        // Also append any user/assistant text blocks in same message
        const text = blocks
          .filter((b: any) => b && b.type === 'text' && typeof b.text === 'string')
          .map((b: any) => b.text)
          .join('\n');
        if (text) { msgs.push({ role, content: text }); }
        continue;
      }

      // Plain user/assistant text-only
      const text = blocks
        .filter((b: any) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b: any) => b.text)
        .join('\n');
      msgs.push({ role, content: text });
    }
    transformed.messages = msgs;
    if (this.enableTools && request.tools) { transformed.tools = this.convertAnthropicToolsToOpenAI(request.tools); }
    // tool_choice mapping (Anthropic -> OpenAI)
    if (request.tool_choice) {
      transformed.tool_choice = this.mapAnthropicToolChoiceToOpenAI(request.tool_choice);
    }
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
      const blocks: any[] = [];
      if (message.content) {
        if (Array.isArray(message.content)) {
          // If upstream already returns array-like content blocks, map text items
          for (const c of message.content) {
            if (typeof c === 'string') { blocks.push({ type: 'text', text: c }); }
            else if (c && typeof c === 'object' && typeof c.text === 'string') { blocks.push({ type: 'text', text: c.text }); }
          }
        } else if (typeof message.content === 'string') {
          blocks.push({ type: 'text', text: message.content });
        }
      }
      // Some providers (e.g., GLM coding API) return reasoning_content instead of content
      if (typeof (message as any).reasoning_content === 'string' && (message as any).reasoning_content.length > 0) {
        blocks.push({ type: 'text', text: (message as any).reasoning_content });
      }
      if (this.enableTools && message.tool_calls) {
        const toolBlocks = this.convertOpenAIToolCallsToAnthropic(message.tool_calls);
        blocks.push(...toolBlocks);
      }
      // Ensure content has at least one text block for Anthropic schema compliance
      if (blocks.length === 0) {
        blocks.push({ type: 'text', text: '' });
      }
      transformed.content = blocks;
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
    return toolCalls.map(call => ({
      type: 'tool_use',
      id: call.id,
      name: call.function?.name,
      input: safeParse(call.function?.arguments) ?? {}
    }));
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

  private mapAnthropicToolChoiceToOpenAI(input: any): any {
    if (!input) { return undefined; }
    if (typeof input === 'string') {
      if (input === 'auto' || input === 'none') { return input; }
      return 'auto';
    }
    if (typeof input === 'object' && input !== null) {
      if (input.type === 'tool' && typeof input.name === 'string') {
        return { type: 'function', function: { name: input.name } };
      }
    }
    return undefined;
  }
}

function safeParse(text: any): any | undefined {
  if (text === undefined || text === null) { return undefined; }
  if (typeof text !== 'string') { return text; }
  try { return JSON.parse(text); } catch { return undefined; }
}

function safeStringify(obj: any): string {
  try { return JSON.stringify(obj ?? {}); } catch { return String(obj); }
}
