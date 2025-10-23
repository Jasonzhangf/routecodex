/**
 * Response Normalizer Utility
 * Normalizes responses from different AI providers to standard formats
 */

import { PipelineDebugLogger } from '../../modules/pipeline/utils/debug-logger.js';

/**
 * Normalized response interface
 */
export interface NormalizedResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: any[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  error?: {
    message: string;
    type: string;
    code: string;
  };
}

/**
 * Response Normalizer Class
 */
export class ResponseNormalizer {
  private logger: PipelineDebugLogger;

  constructor(logger?: PipelineDebugLogger) {
    this.logger = logger || new PipelineDebugLogger(null, {
      enableConsoleLogging: true,
      enableDebugCenter: false,
    });
  }

  /**
   * Normalize OpenAI chat completion response
   */
  normalizeOpenAIResponse(response: any, type: 'chat' | 'completion' = 'chat'): NormalizedResponse {
    try {
      this.logger.logModule('ResponseNormalizer', 'normalize_openai_start', {
        type,
        responseId: response.id,
        model: response.model,
      });

      const normalized: NormalizedResponse = {
        id: response.id || `resp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        object: response.object || (type === 'chat' ? 'chat.completion' : 'text_completion'),
        created: response.created || Math.floor(Date.now() / 1000),
        model: response.model || 'unknown',
        choices: this.normalizeChoices(response.choices || []),
      };

      // Normalize usage information (fallback to input/output tokens for compat providers)
      if (response.usage) {
        const u = response.usage as Record<string, unknown>;
        const prompt = (typeof u.prompt_tokens === 'number')
          ? (u.prompt_tokens as number)
          : (typeof u.input_tokens === 'number' ? (u.input_tokens as number) : 0);
        const completion = (typeof u.completion_tokens === 'number')
          ? (u.completion_tokens as number)
          : (typeof u.output_tokens === 'number' ? (u.output_tokens as number) : 0);
        const total = (typeof u.total_tokens === 'number')
          ? (u.total_tokens as number)
          : (prompt + completion);
        normalized.usage = {
          prompt_tokens: prompt,
          completion_tokens: completion,
          total_tokens: total,
        };
      }

      this.logger.logModule('ResponseNormalizer', 'normalize_openai_complete', {
        responseId: normalized.id,
        choiceCount: normalized.choices.length,
      });

      return normalized;
    } catch (error) {
      this.logger.logModule('ResponseNormalizer', 'normalize_openai_error', {
        error: error instanceof Error ? error.message : String(error),
      });

      return this.createErrorResponse(error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Normalize Anthropic messages response to OpenAI format
   */
  normalizeAnthropicResponse(response: any): NormalizedResponse {
    try {
      this.logger.logModule('ResponseNormalizer', 'normalize_anthropic_start', {
        responseId: response.id,
      });

      const normalized: NormalizedResponse = {
        id: response.id || `resp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: response.model || 'unknown',
        choices: this.normalizeAnthropicChoices(response),
      };

      // Extract usage information from Anthropic response
      if (response.usage) {
        normalized.usage = {
          prompt_tokens: response.usage.input_tokens || 0,
          completion_tokens: response.usage.output_tokens || 0,
          total_tokens: (response.usage.input_tokens || 0) + (response.usage.output_tokens || 0),
        };
      }

      this.logger.logModule('ResponseNormalizer', 'normalize_anthropic_complete', {
        responseId: normalized.id,
      });

      return normalized;
    } catch (error) {
      this.logger.logModule('ResponseNormalizer', 'normalize_anthropic_error', {
        error: error instanceof Error ? error.message : String(error),
      });

      return this.createErrorResponse(error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Normalize response choices array
   */
  private normalizeChoices(choices: any[]): any[] {
    return choices.map((choice, index) => ({
      index: choice.index || index,
      message: choice.message || {
        role: 'assistant',
        content: choice.text || '',
      },
      finish_reason: choice.finish_reason || 'stop',
      delta: choice.delta || null,
    }));
  }

  /**
   * Normalize Anthropic response to OpenAI choices format
   */
  private normalizeAnthropicChoices(response: any): any[] {
    const choices: any[] = [];

    if (response.content) {
      choices.push({
        index: 0,
        message: {
          role: 'assistant',
          content: typeof response.content === 'string'
            ? response.content
            : response.content
                .filter((item: any) => item.type === 'text')
                .map((item: any) => item.text)
                .join('\n'),
        },
        finish_reason: response.stop_reason ? this.mapAnthropicStopReason(response.stop_reason) : 'stop',
      });
    }

    // Handle tool calls if present
    if (response.content && response.content.some((item: any) => item.type === 'tool_use')) {
      const toolCalls = response.content
        .filter((item: any) => item.type === 'tool_use')
        .map((tool: any) => ({
          id: tool.id,
          type: 'function',
          function: {
            name: tool.name,
            arguments: JSON.stringify(tool.input || {}),
          },
        }));

      if (choices.length > 0) {
        choices[0].message.tool_calls = toolCalls;
      }
    }

    return choices;
  }

  /**
   * Map Anthropic stop reasons to OpenAI finish reasons
   */
  private mapAnthropicStopReason(reason: string): string {
    const mapping: Record<string, string> = {
      'end_turn': 'stop',
      'max_tokens': 'length',
      'stop_sequence': 'stop',
      'tool_use': 'tool_calls',
    };

    return mapping[reason] || 'stop';
  }

  /**
   * Create error response
   */
  private createErrorResponse(message: string): NormalizedResponse {
    return {
      id: `error_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'error',
      choices: [],
      error: {
        message,
        type: 'normalization_error',
        code: 'RESPONSE_NORMALIZATION_FAILED',
      },
    };
  }

  /**
   * Validate normalized response
   */
  validateResponse(response: NormalizedResponse): boolean {
    try {
      // Check required fields
      if (!response.id || !response.object || !response.model) {
        return false;
      }

      // Check choices array
      if (!Array.isArray(response.choices) || response.choices.length === 0) {
        return false;
      }

      // Check each choice
      for (const choice of response.choices) {
        if (typeof choice.index !== 'number' || !choice.message) {
          return false;
        }
      }

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Apply response formatting based on configuration
   */
  formatResponse(response: NormalizedResponse, config: {
    includeUsage?: boolean;
    trimWhitespace?: boolean;
    sanitizeContent?: boolean;
  } = {}): NormalizedResponse {
    const formatted = { ...response };

    // Include/exclude usage information
    if (config.includeUsage === false && formatted.usage) {
      delete formatted.usage;
    }

    // Trim whitespace from content
    if (config.trimWhitespace) {
      formatted.choices = formatted.choices.map(choice => ({
        ...choice,
        message: {
          ...choice.message,
          content: typeof choice.message.content === 'string'
            ? choice.message.content.trim()
            : choice.message.content,
        },
      }));
    }

    // Sanitize content if needed
    if (config.sanitizeContent) {
      formatted.choices = formatted.choices.map(choice => ({
        ...choice,
        message: {
          ...choice.message,
          content: this.sanitizeContent(choice.message.content),
        },
      }));
    }

    return formatted;
  }

  /**
   * Sanitize content for safety
   */
  private sanitizeContent(content: any): any {
    if (typeof content === 'string') {
      // Basic sanitization - can be extended
      return content
        .replace(/[\x00-\x1F\x7F]/g, '') // Remove control characters
        .trim();
    }

    return content;
  }
}
