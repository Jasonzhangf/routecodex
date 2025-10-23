/**
 * Request Validator Utility
 * Provides centralized request validation for all protocol handlers
 */

import { type OpenAIChatCompletionRequest } from '../types.js';
import { RouteCodexError } from '../types.js';

/**
 * Validation result interface
 */
export interface ValidationResult {
  isValid: boolean;
  errors: string[];
}

/**
 * Request validation options
 */
export interface ValidationOptions {
  strictMode?: boolean;
  allowUnknownFields?: boolean;
  maxMessageCount?: number;
  maxTokens?: number;
}

/**
 * Default validation options
 */
const DEFAULT_OPTIONS: ValidationOptions = {
  strictMode: true,
  allowUnknownFields: false,
  maxMessageCount: 100,
  maxTokens: 32768,
};

/**
 * Request Validator Class
 */
export class RequestValidator {
  private options: ValidationOptions;

  constructor(options: ValidationOptions = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Validate chat completion request
   */
  validateChatCompletion(request: unknown): ValidationResult {
    const errors: string[] = [];

    // Basic type validation
    if (!request || typeof request !== 'object') {
      errors.push('Request must be a valid object');
      return { isValid: false, errors };
    }

    const req = request as Record<string, unknown>;

    // Required fields validation
    if (!req.model || typeof req.model !== 'string') {
      errors.push('model field is required and must be a string');
    }

    if (!req.messages || !Array.isArray(req.messages)) {
      errors.push('messages field is required and must be an array');
    } else {
      const messageErrors = this.validateMessagesArray(req.messages);
      errors.push(...messageErrors);
    }

    // Optional fields validation
    if (req.max_tokens !== undefined) {
      if (typeof req.max_tokens !== 'number' || req.max_tokens <= 0) {
        errors.push('max_tokens must be a positive number');
      } else if (req.max_tokens > this.options.maxTokens!) {
        errors.push(`max_tokens cannot exceed ${this.options.maxTokens}`);
      }
    }

    if (req.temperature !== undefined) {
      if (typeof req.temperature !== 'number' || req.temperature < 0 || req.temperature > 2) {
        errors.push('temperature must be a number between 0 and 2');
      }
    }

    if (req.top_p !== undefined) {
      if (typeof req.top_p !== 'number' || req.top_p <= 0 || req.top_p > 1) {
        errors.push('top_p must be a number between 0 and 1');
      }
    }

    if (req.stream !== undefined && typeof req.stream !== 'boolean') {
      errors.push('stream must be a boolean');
    }

    if (req.tools !== undefined) {
      if (!Array.isArray(req.tools)) {
        errors.push('tools must be an array');
      } else {
        const toolErrors = this.validateTools(req.tools);
        errors.push(...toolErrors);
      }
    }

    if (req.tool_choice !== undefined) {
      const toolChoiceErrors = this.validateToolChoice(req.tool_choice);
      errors.push(...toolChoiceErrors);
    }

    return {
      isValid: errors.length === 0,
      errors,
    };
  }

  /**
   * Validate messages array
   */
  private validateMessagesArray(messages: unknown[]): string[] {
    const errors: string[] = [];

    if (messages.length === 0) {
      errors.push('messages array cannot be empty');
    }

    if (messages.length > this.options.maxMessageCount!) {
      errors.push(`messages array cannot exceed ${this.options.maxMessageCount} items`);
    }

    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      const messageErrors = this.validateMessage(message, i);
      errors.push(...messageErrors);
    }

    return errors;
  }

  /**
   * Validate individual message
   */
  private validateMessage(message: unknown, index: number): string[] {
    const errors: string[] = [];

    if (!message || typeof message !== 'object') {
      errors.push(`Message at index ${index} must be a valid object`);
      return errors;
    }

    const msg = message as Record<string, unknown>;

    // Role validation
    if (!msg.role || typeof msg.role !== 'string') {
      errors.push(`Message at index ${index} must have a role field`);
    } else if (!['system', 'user', 'assistant', 'tool'].includes(msg.role)) {
      errors.push(`Message at index ${index} has invalid role: ${msg.role}`);
    }

    // Content validation
    if (msg.content !== undefined && msg.content !== null) {
      if (typeof msg.content !== 'string') {
        errors.push(`Message at index ${index} content must be a string or null`);
      }
    }

    // Tool call validation for assistant messages
    if (msg.role === 'assistant' && msg.tool_calls) {
      if (!Array.isArray(msg.tool_calls)) {
        errors.push(`Message at index ${index} tool_calls must be an array`);
      } else {
        msg.tool_calls.forEach((toolCall: unknown, toolIndex: number) => {
          const toolCallErrors = this.validateToolCall(toolCall, index, toolIndex);
          errors.push(...toolCallErrors);
        });
      }
    }

    // Tool call ID validation for tool messages
    if (msg.role === 'tool') {
      if (!msg.tool_call_id || typeof msg.tool_call_id !== 'string') {
        errors.push(`Tool message at index ${index} must have tool_call_id`);
      }
    }

    return errors;
  }

  /**
   * Validate tool call
   */
  private validateToolCall(toolCall: unknown, messageIndex: number, toolIndex: number): string[] {
    const errors: string[] = [];

    if (!toolCall || typeof toolCall !== 'object') {
      errors.push(`Tool call at message ${messageIndex}, tool ${toolIndex} must be a valid object`);
      return errors;
    }

    const tc = toolCall as Record<string, unknown>;

    if (!tc.id || typeof tc.id !== 'string') {
      errors.push(`Tool call at message ${messageIndex}, tool ${toolIndex} must have an id`);
    }

    if (!tc.type || typeof tc.type !== 'string') {
      errors.push(`Tool call at message ${messageIndex}, tool ${toolIndex} must have a type`);
    } else if (tc.type !== 'function') {
      errors.push(`Tool call at message ${messageIndex}, tool ${toolIndex} type must be 'function'`);
    }

    if (!tc.function || typeof tc.function !== 'object') {
      errors.push(`Tool call at message ${messageIndex}, tool ${toolIndex} must have a function`);
    } else {
      const func = tc.function as Record<string, unknown>;

      if (!func.name || typeof func.name !== 'string') {
        errors.push(`Tool function at message ${messageIndex}, tool ${toolIndex} must have a name`);
      }

      if (func.arguments !== undefined && typeof func.arguments !== 'string') {
        errors.push(`Tool function arguments at message ${messageIndex}, tool ${toolIndex} must be a string`);
      }
    }

    return errors;
  }

  /**
   * Validate tools array
   */
  private validateTools(tools: unknown[]): string[] {
    const errors: string[] = [];

    for (let i = 0; i < tools.length; i++) {
      const tool = tools[i];
      const toolErrors = this.validateTool(tool, i);
      errors.push(...toolErrors);
    }

    return errors;
  }

  /**
   * Validate individual tool
   */
  private validateTool(tool: unknown, index: number): string[] {
    const errors: string[] = [];

    if (!tool || typeof tool !== 'object') {
      errors.push(`Tool at index ${index} must be a valid object`);
      return errors;
    }

    const t = tool as Record<string, unknown>;

    if (!t.type || typeof t.type !== 'string') {
      errors.push(`Tool at index ${index} must have a type`);
    } else if (t.type !== 'function') {
      errors.push(`Tool at index ${index} type must be 'function'`);
    }

    if (!t.function || typeof t.function !== 'object') {
      errors.push(`Tool at index ${index} must have a function`);
    } else {
      const func = t.function as Record<string, unknown>;

      if (!func.name || typeof func.name !== 'string') {
        errors.push(`Tool function at index ${index} must have a name`);
      }

      if (func.description && typeof func.description !== 'string') {
        errors.push(`Tool function description at index ${index} must be a string`);
      }

      if (func.parameters) {
        if (typeof func.parameters !== 'object') {
          errors.push(`Tool function parameters at index ${index} must be an object`);
        } else {
          const schemaErrors = this.validateJSONSchema(func.parameters, `tool.${index}.function.parameters`);
          errors.push(...schemaErrors);
        }
      }
    }

    return errors;
  }

  /**
   * Validate tool choice
   */
  private validateToolChoice(toolChoice: unknown): string[] {
    const errors: string[] = [];

    if (typeof toolChoice === 'string') {
      if (!['none', 'auto', 'required'].includes(toolChoice)) {
        errors.push(`tool_choice string must be one of: none, auto, required`);
      }
    } else if (typeof toolChoice === 'object' && toolChoice !== null) {
      const tc = toolChoice as Record<string, unknown>;

      if (!tc.type || typeof tc.type !== 'string') {
        errors.push(`tool_choice object must have a type field`);
      } else if (tc.type !== 'function') {
        errors.push(`tool_choice object type must be 'function'`);
      }

      if (tc.type === 'function') {
        if (!tc.function || typeof tc.function !== 'object') {
          errors.push(`tool_choice function must have a function object`);
        } else {
          const func = tc.function as Record<string, unknown>;

          if (!func.name || typeof func.name !== 'string') {
            errors.push(`tool_choice function must have a name`);
          }
        }
      }
    } else {
      errors.push(`tool_choice must be a string or object`);
    }

    return errors;
  }

  /**
   * Validate JSON Schema
   */
  private validateJSONSchema(schema: unknown, context: string): string[] {
    const errors: string[] = [];

    if (!schema || typeof schema !== 'object') {
      errors.push(`${context} must be a valid object`);
      return errors;
    }

    const s = schema as Record<string, unknown>;

    if (s.type !== undefined && typeof s.type !== 'string') {
      errors.push(`${context}.type must be a string`);
    }

    if (s.properties !== undefined) {
      if (typeof s.properties !== 'object') {
        errors.push(`${context}.properties must be an object`);
      }
    }

    if (s.required !== undefined) {
      if (!Array.isArray(s.required) || s.required.some(item => typeof item !== 'string')) {
        errors.push(`${context}.required must be an array of strings`);
      }
    }

    return errors;
  }

  /**
   * Validate completion request (non-chat)
   */
  validateCompletion(request: unknown): ValidationResult {
    const errors: string[] = [];

    if (!request || typeof request !== 'object') {
      errors.push('Request must be a valid object');
      return { isValid: false, errors };
    }

    const req = request as Record<string, unknown>;

    if (!req.model || typeof req.model !== 'string') {
      errors.push('model field is required and must be a string');
    }

    if (!req.prompt || typeof req.prompt !== 'string') {
      errors.push('prompt field is required and must be a string');
    }

    if (req.max_tokens !== undefined) {
      if (typeof req.max_tokens !== 'number' || req.max_tokens <= 0) {
        errors.push('max_tokens must be a positive number');
      }
    }

    if (req.temperature !== undefined) {
      if (typeof req.temperature !== 'number' || req.temperature < 0 || req.temperature > 2) {
        errors.push('temperature must be a number between 0 and 2');
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
    };
  }

  /**
   * Validate embedding request
   */
  validateEmbedding(request: unknown): ValidationResult {
    const errors: string[] = [];

    if (!request || typeof request !== 'object') {
      errors.push('Request must be a valid object');
      return { isValid: false, errors };
    }

    const req = request as Record<string, unknown>;

    if (!req.model || typeof req.model !== 'string') {
      errors.push('model field is required and must be a string');
    }

    if (!req.input) {
      errors.push('input field is required');
    } else if (typeof req.input !== 'string' && !Array.isArray(req.input)) {
      errors.push('input must be a string or array of strings');
    } else if (Array.isArray(req.input) && req.input.some(item => typeof item !== 'string')) {
      errors.push('all items in input array must be strings');
    }

    return {
      isValid: errors.length === 0,
      errors,
    };
  }

  /**
   * Validate Anthropic messages request
   */
  validateMessages(request: unknown): ValidationResult {
    const errors: string[] = [];

    if (!request || typeof request !== 'object') {
      errors.push('Request must be a valid object');
      return { isValid: false, errors };
    }

    const req = request as Record<string, unknown>;

    // Required fields
    if (!req.model || typeof req.model !== 'string') {
      errors.push('model field is required and must be a string');
    }

    if (!req.messages || !Array.isArray(req.messages)) {
      errors.push('messages field is required and must be an array');
    } else {
      if (req.messages.length === 0) {
        errors.push('messages array cannot be empty');
      }

      if (req.messages.length > this.options.maxMessageCount!) {
        errors.push(`messages array cannot exceed ${this.options.maxMessageCount} items`);
      }

      for (let i = 0; i < req.messages.length; i++) {
        const message = req.messages[i];
        const messageErrors = this.validateAnthropicMessage(message, i);
        errors.push(...messageErrors);
      }
    }

    // Optional fields
    if (req.max_tokens !== undefined) {
      if (typeof req.max_tokens !== 'number' || req.max_tokens <= 0) {
        errors.push('max_tokens must be a positive number');
      }
    }

    if (req.temperature !== undefined) {
      if (typeof req.temperature !== 'number' || req.temperature < 0 || req.temperature > 1) {
        errors.push('temperature must be a number between 0 and 1');
      }
    }

    if (req.top_p !== undefined) {
      if (typeof req.top_p !== 'number' || req.top_p <= 0 || req.top_p > 1) {
        errors.push('top_p must be a number between 0 and 1');
      }
    }

    if (req.stream !== undefined && typeof req.stream !== 'boolean') {
      errors.push('stream must be a boolean');
    }

    return {
      isValid: errors.length === 0,
      errors,
    };
  }

  /**
   * Validate Anthropic response request
   */
  validateAnthropicResponse(request: unknown): ValidationResult {
    // Anthropic responses use the same format as messages
    return this.validateMessages(request);
  }

  /**
   * Validate individual Anthropic message
   */
  private validateAnthropicMessage(message: unknown, index: number): string[] {
    const errors: string[] = [];

    if (!message || typeof message !== 'object') {
      errors.push(`Message at index ${index} must be a valid object`);
      return errors;
    }

    const msg = message as Record<string, unknown>;

    // Role validation
    if (!msg.role || typeof msg.role !== 'string') {
      errors.push(`Message at index ${index} must have a role field`);
    } else if (!['user', 'assistant', 'system'].includes(msg.role)) {
      errors.push(`Message at index ${index} has invalid role: ${msg.role}`);
    }

    // Content validation
    if (!msg.content) {
      errors.push(`Message at index ${index} must have content`);
    } else if (typeof msg.content !== 'string' && !Array.isArray(msg.content)) {
      errors.push(`Message at index ${index} content must be a string or array`);
    } else if (Array.isArray(msg.content)) {
      for (let i = 0; i < msg.content.length; i++) {
        const content = msg.content[i];
        const contentErrors = this.validateAnthropicContent(content, index, i);
        errors.push(...contentErrors);
      }
    }

    return errors;
  }

  /**
   * Validate Anthropic content block
   */
  private validateAnthropicContent(content: unknown, messageIndex: number, contentIndex: number): string[] {
    const errors: string[] = [];

    if (!content || typeof content !== 'object') {
      errors.push(`Content at message ${messageIndex}, block ${contentIndex} must be a valid object`);
      return errors;
    }

    const c = content as Record<string, unknown>;

    if (!c.type || typeof c.type !== 'string') {
      errors.push(`Content at message ${messageIndex}, block ${contentIndex} must have a type`);
    } else if (!['text', 'image', 'tool_use', 'tool_result', 'message', 'reasoning', 'function_call', 'function_call_output'].includes(c.type)) {
      // For unknown/extended types, do not fail hard; allow pipeline/adapters to filter.
      // errors.push(`Content at message ${messageIndex}, block ${contentIndex} has invalid type: ${c.type}`);
    }

    if (c.type === 'text' && !c.text) {
      errors.push(`Text content at message ${messageIndex}, block ${contentIndex} must have text`);
    }

    if (c.type === 'image' && (!c.source || typeof c.source !== 'object')) {
      errors.push(`Image content at message ${messageIndex}, block ${contentIndex} must have a source`);
    }

    if (c.type === 'tool_use' && (!c.id || typeof c.id !== 'string')) {
      errors.push(`Tool use content at message ${messageIndex}, block ${contentIndex} must have an id`);
    }

    return errors;
  }
}
