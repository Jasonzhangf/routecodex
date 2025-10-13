/**
 * Conversion Engine for OpenAI <> Anthropic protocol conversion
 * Uses AJV for validation and provides intelligent transformation logic
 */

import type {
  LLMSwitchRequest,
  LLMSwitchResponse,
  ConversionDirection,
  ConversionContext,
  MessageFormat,
  OpenAIMessage,
  AnthropicMessage,
  OpenAITool,
  AnthropicTool,
  ToolSchemaMap,
  ValidationResult
} from '../types/index.js';
import { AjvSchemaMapper } from './schema-mapper.js';
import { ValidationError, ConversionError } from '../types/index.js';

/**
 * Conversion Engine
 *
 * Handles the core logic for converting between OpenAI and Anthropic formats.
 * Uses AJV for validation and provides detailed error reporting.
 */
export class ConversionEngine {
  private schemaMapper: AjvSchemaMapper;

  constructor() {
    this.schemaMapper = new AjvSchemaMapper();
  }

  /**
   * Convert OpenAI request to Anthropic format
   */
  convertOpenAIToAnthropic(request: any, context: ConversionContext): any {
    const startTime = performance.now();

    try {
      // Validate input format
      const validation = this.schemaMapper.validateOpenAIRequest(request);
      if (!validation.valid) {
        throw new ValidationError(
          `Invalid OpenAI request format: ${validation.errors?.map(e => e.message).join(', ')}`,
          validation.errors || [],
          { request, context }
        );
      }

      const anthropicRequest: any = {};

      // Extract system message
      const messages = Array.isArray(request.messages) ? request.messages : [];
      const systemMsg = messages.find((m: any) => m.role === 'system');
      if (systemMsg && typeof systemMsg.content === 'string') {
        anthropicRequest.system = systemMsg.content;
      }

      // Convert messages
      anthropicRequest.messages = this.convertMessagesOpenAIToAnthropic(
        messages.filter((m: any) => m.role !== 'system'),
        context
      );

      // Copy basic parameters
      if (request.model) anthropicRequest.model = request.model;
      if (typeof request.max_tokens === 'number') {
        anthropicRequest.max_tokens = request.max_tokens;
      }
      if (typeof request.temperature === 'number') {
        anthropicRequest.temperature = Math.min(1, Math.max(0, request.temperature));
      }
      if (typeof request.top_p === 'number') {
        anthropicRequest.top_p = request.top_p;
      }

      // Convert tools
      if (request.tools && Array.isArray(request.tools)) {
        anthropicRequest.tools = this.convertToolsOpenAIToAnthropic(request.tools);
      }

      // Convert tool_choice
      if (request.tool_choice !== undefined) {
        anthropicRequest.tool_choice = this.convertToolChoiceOpenAIToAnthropic(request.tool_choice);
      }

      // Copy stream flag
      if (typeof request.stream === 'boolean') {
        anthropicRequest.stream = request.stream;
      }

      // Validate output
      const outputValidation = this.schemaMapper.validateAnthropicRequest(anthropicRequest);
      if (!outputValidation.valid) {
        throw new ConversionError(
          `Generated invalid Anthropic request: ${outputValidation.errors?.map(e => e.message).join(', ')}`,
          'conversion_validation_failed',
          { anthropicRequest, errors: outputValidation.errors }
        );
      }

      const endTime = performance.now();
      context.metrics.conversionTime += (endTime - startTime);

      return anthropicRequest;
    } catch (error) {
      const endTime = performance.now();
      context.metrics.conversionTime += (endTime - startTime);
      context.metrics.errorCount++;
      throw error;
    }
  }

  /**
   * Convert Anthropic request to OpenAI format
   */
  convertAnthropicToOpenAI(request: any, context: ConversionContext): any {
    const startTime = performance.now();

    try {
      // Validate input format
      const validation = this.schemaMapper.validateAnthropicRequest(request);
      if (!validation.valid) {
        throw new ValidationError(
          `Invalid Anthropic request format: ${validation.errors?.map(e => e.message).join(', ')}`,
          validation.errors || [],
          { request, context }
        );
      }

      const openAIRequest: any = {};

      // Build messages array
      const messages: OpenAIMessage[] = [];

      // Add system message if present
      if (request.system) {
        messages.push({
          role: 'system',
          content: Array.isArray(request.system) ? request.system.join('\n') : String(request.system)
        });
      }

      // Convert Anthropic messages
      messages.push(...this.convertMessagesAnthropicToOpenAI(request.messages || [], context));
      openAIRequest.messages = messages;

      // Copy basic parameters
      if (request.model) openAIRequest.model = request.model;
      if (typeof request.temperature === 'number') {
        openAIRequest.temperature = Math.min(2, Math.max(0, request.temperature));
      }
      if (typeof request.max_tokens === 'number') {
        openAIRequest.max_tokens = request.max_tokens;
      }
      if (typeof request.top_p === 'number') {
        openAIRequest.top_p = request.top_p;
      }

      // Convert tools
      if (request.tools && Array.isArray(request.tools)) {
        openAIRequest.tools = this.convertToolsAnthropicToOpenAI(request.tools);
      }

      // Convert tool_choice
      if (request.tool_choice !== undefined) {
        openAIRequest.tool_choice = this.convertToolChoiceAnthropicToOpenAI(request.tool_choice);
      }

      // Copy stream flag
      if (typeof request.stream === 'boolean') {
        openAIRequest.stream = request.stream;
      }

      // Validate output
      const outputValidation = this.schemaMapper.validateOpenAIRequest(openAIRequest);
      if (!outputValidation.valid) {
        throw new ConversionError(
          `Generated invalid OpenAI request: ${outputValidation.errors?.map(e => e.message).join(', ')}`,
          'conversion_validation_failed',
          { openAIRequest, errors: outputValidation.errors }
        );
      }

      const endTime = performance.now();
      context.metrics.conversionTime += (endTime - startTime);

      return openAIRequest;
    } catch (error) {
      const endTime = performance.now();
      context.metrics.conversionTime += (endTime - startTime);
      context.metrics.errorCount++;
      throw error;
    }
  }

  /**
   * Convert OpenAI response to Anthropic format
   */
  convertOpenAIToAnthropicResponse(response: any, context: ConversionContext): any {
    const startTime = performance.now();

    try {
      // Validate input format
      const validation = this.schemaMapper.validateOpenAIResponse(response);
      if (!validation.valid) {
        throw new ValidationError(
          `Invalid OpenAI response format: ${validation.errors?.map(e => e.message).join(', ')}`,
          validation.errors || [],
          { response, context }
        );
      }

      const anthropicResponse: any = {
        type: 'message',
        role: 'assistant',
        content: []
      };

      // Copy basic fields
      if (response.id) anthropicResponse.id = response.id;
      if (response.model) anthropicResponse.model = response.model;
      if (response.created) anthropicResponse.created = response.created;

      // Process choices
      if (response.choices && response.choices.length > 0) {
        const choice = response.choices[0];
        const message = choice.message || {};

        // Handle text content
        if (message.content && typeof message.content === 'string') {
          anthropicResponse.content.push({
            type: 'text',
            text: message.content
          });
        }

        // Handle tool calls
        if (message.tool_calls && Array.isArray(message.tool_calls)) {
          for (const toolCall of message.tool_calls) {
            const toolUseBlock = this.convertToolCallToToolUse(toolCall, context);
            if (toolUseBlock) {
              anthropicResponse.content.push(toolUseBlock);
            }
          }
        }

        // Handle legacy function_call
        if (message.function_call) {
          const toolUseBlock = this.convertFunctionCallToToolUse(message.function_call, context);
          if (toolUseBlock) {
            anthropicResponse.content.push(toolUseBlock);
          }
        }

        // Map finish reason
        if (choice.finish_reason) {
          anthropicResponse.stop_reason = this.mapFinishReasonOpenAIToAnthropic(choice.finish_reason);
        }
      }

      // Ensure content has at least one text block
      if (anthropicResponse.content.length === 0) {
        anthropicResponse.content.push({ type: 'text', text: '' });
      }

      // Convert usage information
      if (response.usage) {
        anthropicResponse.usage = {
          input_tokens: response.usage.prompt_tokens || 0,
          output_tokens: response.usage.completion_tokens || 0
        };
      }

      // Validate output
      const outputValidation = this.schemaMapper.validateAnthropicResponse(anthropicResponse);
      if (!outputValidation.valid) {
        throw new ConversionError(
          `Generated invalid Anthropic response: ${outputValidation.errors?.map(e => e.message).join(', ')}`,
          'conversion_validation_failed',
          { anthropicResponse, errors: outputValidation.errors }
        );
      }

      const endTime = performance.now();
      context.metrics.conversionTime += (endTime - startTime);

      return anthropicResponse;
    } catch (error) {
      const endTime = performance.now();
      context.metrics.conversionTime += (endTime - startTime);
      context.metrics.errorCount++;
      throw error;
    }
  }

  /**
   * Convert Anthropic response to OpenAI format
   */
  convertAnthropicToOpenAIResponse(response: any, context: ConversionContext): any {
    const startTime = performance.now();

    try {
      // Validate input format
      const validation = this.schemaMapper.validateAnthropicResponse(response);
      if (!validation.valid) {
        throw new ValidationError(
          `Invalid Anthropic response format: ${validation.errors?.map(e => e.message).join(', ')}`,
          validation.errors || [],
          { response, context }
        );
      }

      const openAIResponse: any = {
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: '',
            tool_calls: []
          },
          finish_reason: 'stop'
        }]
      };

      // Copy basic fields
      if (response.id) openAIResponse.id = response.id;
      if (response.model) openAIResponse.model = response.model;
      if (response.created) openAIResponse.created = response.created;
      openAIResponse.object = 'chat.completion';

      // Process content blocks
      const toolCalls: any[] = [];
      const textParts: string[] = [];

      if (response.content && Array.isArray(response.content)) {
        for (const block of response.content) {
          if (block.type === 'text' && block.text) {
            textParts.push(block.text);
          } else if (block.type === 'tool_use') {
            const toolCall = this.convertToolUseToToolCall(block, context);
            if (toolCall) {
              toolCalls.push(toolCall);
            }
          }
        }
      }

      // Set message content
      openAIResponse.choices[0].message.content = textParts.join('\n');

      // Set tool calls
      if (toolCalls.length > 0) {
        openAIResponse.choices[0].message.tool_calls = toolCalls;
        openAIResponse.choices[0].finish_reason = 'tool_calls';
      }

      // Map stop reason
      if (response.stop_reason) {
        openAIResponse.choices[0].finish_reason = this.mapFinishReasonAnthropicToOpenAI(response.stop_reason);
      }

      // Convert usage information
      if (response.usage) {
        openAIResponse.usage = {
          prompt_tokens: response.usage.input_tokens || 0,
          completion_tokens: response.usage.output_tokens || 0,
          total_tokens: (response.usage.input_tokens || 0) + (response.usage.output_tokens || 0)
        };
      }

      // Validate output
      const outputValidation = this.schemaMapper.validateOpenAIResponse(openAIResponse);
      if (!outputValidation.valid) {
        throw new ConversionError(
          `Generated invalid OpenAI response: ${outputValidation.errors?.map(e => e.message).join(', ')}`,
          'conversion_validation_failed',
          { openAIResponse, errors: outputValidation.errors }
        );
      }

      const endTime = performance.now();
      context.metrics.conversionTime += (endTime - startTime);

      return openAIResponse;
    } catch (error) {
      const endTime = performance.now();
      context.metrics.conversionTime += (endTime - startTime);
      context.metrics.errorCount++;
      throw error;
    }
  }

  /**
   * Get schema mapper instance
   */
  getSchemaMapper(): AjvSchemaMapper {
    return this.schemaMapper;
  }

  // Private helper methods for specific conversions

  private convertMessagesOpenAIToAnthropic(messages: OpenAIMessage[], context: ConversionContext): AnthropicMessage[] {
    const anthropicMessages: AnthropicMessage[] = [];
    const producedToolIds = new Set<string>();

    for (const message of messages) {
      const contentBlocks: any[] = [];

      if (message.role === 'assistant' && message.tool_calls) {
        // Convert tool_calls to tool_use blocks
        for (const toolCall of message.tool_calls) {
          const toolUseBlock = this.convertToolCallToToolUse(toolCall, context);
          if (toolUseBlock) {
            contentBlocks.push(toolUseBlock);
            producedToolIds.add(toolUseBlock.id);
          }
        }
      } else if (message.role === 'tool') {
        // Convert tool role to tool_result
        contentBlocks.push({
          type: 'tool_result',
          tool_use_id: message.tool_call_id || '',
          content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content || {})
        });
      }

      // Handle text content
      if (typeof message.content === 'string' && message.content.trim()) {
        contentBlocks.push({
          type: 'text',
          text: message.content
        });
      }

      anthropicMessages.push({
        role: message.role === 'system' ? 'user' : message.role as 'user' | 'assistant',
        content: contentBlocks.length > 0 ? contentBlocks : [{ type: 'text', text: '' }]
      });
    }

    return anthropicMessages;
  }

  private convertMessagesAnthropicToOpenAI(messages: AnthropicMessage[], context: ConversionContext): OpenAIMessage[] {
    const openAIMessages: OpenAIMessage[] = [];
    const producedToolIds = new Set<string>();

    for (const message of messages) {
      const openAIMessage: OpenAIMessage = {
        role: message.role,
        content: '',
        tool_calls: []
      };

      const textParts: string[] = [];

      if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block.type === 'text' && block.text) {
            textParts.push(block.text);
          } else if (block.type === 'tool_use') {
            const toolCall = this.convertToolUseToToolCall(block, context);
            if (toolCall) {
              openAIMessage.tool_calls!.push(toolCall);
              producedToolIds.add(toolCall.id);
            }
          } else if (block.type === 'tool_result') {
            // Create a separate tool message for tool_result
            openAIMessages.push({
              role: 'tool',
              content: block.content || '',
              tool_call_id: block.tool_use_id || ''
            });
          }
        }
      } else if (typeof message.content === 'string') {
        textParts.push(message.content);
      }

      openAIMessage.content = textParts.join('\n');
      if (openAIMessage.tool_calls!.length === 0) {
        delete openAIMessage.tool_calls;
      }

      openAIMessages.push(openAIMessage);
    }

    return openAIMessages;
  }

  private convertToolsOpenAIToAnthropic(tools: OpenAITool[]): AnthropicTool[] {
    return tools.map(tool => ({
      name: tool.function.name,
      description: tool.function.description || '',
      input_schema: tool.function.parameters
    }));
  }

  private convertToolsAnthropicToOpenAI(tools: AnthropicTool[]): OpenAITool[] {
    return tools.map(tool => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description || '',
        parameters: tool.input_schema
      }
    }));
  }

  private convertToolChoiceOpenAIToAnthropic(toolChoice: any): any {
    if (typeof toolChoice === 'string') {
      if (toolChoice === 'none') return 'none';
      if (toolChoice === 'auto' || toolChoice === 'required') return 'auto';
      return 'auto';
    } else if (typeof toolChoice === 'object' && toolChoice.type === 'function') {
      return {
        type: 'tool',
        name: toolChoice.function.name
      };
    }
    return 'auto';
  }

  private convertToolChoiceAnthropicToOpenAI(toolChoice: any): any {
    if (typeof toolChoice === 'string') {
      if (toolChoice === 'none') return 'none';
      return 'auto';
    } else if (typeof toolChoice === 'object' && toolChoice.type === 'tool') {
      return {
        type: 'function',
        function: { name: toolChoice.name }
      };
    }
    return 'auto';
  }

  private convertToolCallToToolUse(toolCall: any, context: ConversionContext): any {
    try {
      let args = {};
      if (typeof toolCall.function?.arguments === 'string') {
        args = JSON.parse(toolCall.function.arguments);
      }

      // Validate and normalize arguments
      const validation = this.schemaMapper.validateToolParameters(
        toolCall.function?.name || 'unknown',
        args,
        'openai-to-anthropic'
      );

      return {
        type: 'tool_use',
        id: toolCall.id || `call_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        name: toolCall.function?.name || 'unknown',
        input: validation.valid ? validation.data : args
      };
    } catch (error) {
      // Return basic tool_use if parsing fails
      return {
        type: 'tool_use',
        id: toolCall.id || `call_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        name: toolCall.function?.name || 'unknown',
        input: {}
      };
    }
  }

  private convertFunctionCallToToolUse(functionCall: any, context: ConversionContext): any {
    try {
      let args = {};
      if (typeof functionCall?.arguments === 'string') {
        args = JSON.parse(functionCall.arguments);
      }

      return {
        type: 'tool_use',
        id: `call_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        name: functionCall?.name || 'unknown',
        input: args
      };
    } catch (error) {
      return null;
    }
  }

  private convertToolUseToToolCall(toolUse: any, context: ConversionContext): any {
    return {
      id: toolUse.id || `call_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      type: 'function',
      function: {
        name: toolUse.name || 'unknown',
        arguments: JSON.stringify(toolUse.input || {})
      }
    };
  }

  private mapFinishReasonOpenAIToAnthropic(openaiReason: string): string {
    const mapping: Record<string, string> = {
      'stop': 'end_turn',
      'length': 'max_tokens',
      'tool_calls': 'tool_use',
      'function_call': 'tool_use',
      'content_filter': 'stop_sequence'
    };
    return mapping[openaiReason] || 'end_turn';
  }

  private mapFinishReasonAnthropicToOpenAI(anthropicReason: string): string {
    const mapping: Record<string, string> = {
      'end_turn': 'stop',
      'max_tokens': 'length',
      'tool_use': 'tool_calls',
      'stop_sequence': 'stop'
    };
    return mapping[anthropicReason] || 'stop';
  }
}