/**
 * Base Converter Abstract Class
 * Abstract base class for all protocol converters in the LLMSwitch system.
 * Provides common functionality and interface for request/response transformation.
 */

import { PipelineDebugLogger } from '../../../utils/debug-logger.js';
import { ServiceContainer } from '../../../../../server/core/service-container.js';

/**
 * Conversion configuration interface
 */
export interface ConversionConfig {
  enableTools?: boolean;
  enableCaching?: boolean;
  strictValidation?: boolean;
  toolMapping?: Record<string, string>;
  modelMapping?: Record<string, string>;
}

/**
 * Conversion context interface
 */
export interface ConversionContext {
  requestId: string;
  timestamp: number;
  sourceProtocol: string;
  targetProtocol: string;
  metadata?: Record<string, unknown>;
}

/**
 * Conversion result interface
 */
export interface ConversionResult {
  success: boolean;
  data: unknown;
  errors?: string[];
  warnings?: string[];
  metadata?: Record<string, unknown>;
}

/**
 * Base converter abstract class
 */
export abstract class BaseConverter {
  protected logger: PipelineDebugLogger;
  protected config: ConversionConfig;
  protected serviceContainer: ServiceContainer;
  protected cache: Map<string, unknown> = new Map();

  constructor(logger: PipelineDebugLogger, config: ConversionConfig = {}, serviceContainer?: ServiceContainer) {
    this.logger = logger;
    this.config = {
      enableTools: true,
      enableCaching: false,
      strictValidation: true,
      ...config,
    };

    // Use provided service container or get default instance
    this.serviceContainer = serviceContainer || ServiceContainer.getInstance();
  }

  /**
   * Convert incoming request
   */
  abstract convertRequest(request: unknown, context: ConversionContext): Promise<ConversionResult>;

  /**
   * Convert outgoing response
   */
  abstract convertResponse(response: unknown, context: ConversionContext): Promise<ConversionResult>;

  /**
   * Detect protocol format
   */
  protected detectFormat(data: unknown): 'openai' | 'anthropic' | 'responses' | 'unknown' {
    if (!data || typeof data !== 'object') {
      return 'unknown';
    }

    const obj = data as Record<string, unknown>;

    // OpenAI format detection
    if (Array.isArray(obj.messages) && typeof obj.model === 'string') {
      return 'openai';
    }

    // Anthropic format detection
    if (Array.isArray(obj.messages) && typeof obj.model === 'string' && obj.system !== undefined) {
      return 'anthropic';
    }

    // Responses format detection
    if (obj.input !== undefined || obj.output !== undefined) {
      return 'responses';
    }

    return 'unknown';
  }

  /**
   * Validate conversion result
   */
  protected validateResult(result: ConversionResult): boolean {
    if (!result.success) {
      return false;
    }

    if (!result.data) {
      return false;
    }

    return true;
  }

  /**
   * Log conversion operation
   */
  protected logConversion(
    operation: string,
    input: unknown,
    output: unknown,
    context: ConversionContext,
    metadata?: Record<string, unknown>
  ): void {
    this.logger.logModule('BaseConverter', 'conversion_operation', {
      operation,
      requestId: context.requestId,
      sourceProtocol: context.sourceProtocol,
      targetProtocol: context.targetProtocol,
      timestamp: Date.now(),
      inputSize: JSON.stringify(input).length,
      outputSize: JSON.stringify(output).length,
      ...metadata,
    });
  }

  /**
   * Get cache key for conversion
   */
  protected getCacheKey(data: unknown, context: ConversionContext): string {
    const dataHash = JSON.stringify(data);
    const contextHash = JSON.stringify({
      sourceProtocol: context.sourceProtocol,
      targetProtocol: context.targetProtocol,
    });
    return `${dataHash}_${contextHash}`;
  }

  /**
   * Check cache for existing conversion
   */
  protected checkCache(key: string): unknown | null {
    if (!this.config.enableCaching) {
      return null;
    }
    return this.cache.get(key) || null;
  }

  /**
   * Store conversion result in cache
   */
  protected storeCache(key: string, result: unknown): void {
    if (!this.config.enableCaching) {
      return;
    }
    this.cache.set(key, result);
  }

  /**
   * Handle conversion error
   */
  protected handleConversionError(error: unknown, context: ConversionContext): ConversionResult {
    const errorMessage = error instanceof Error ? error.message : String(error);

    this.logger.logModule('BaseConverter', 'conversion_error', {
      requestId: context.requestId,
      error: errorMessage,
      sourceProtocol: context.sourceProtocol,
      targetProtocol: context.targetProtocol,
      timestamp: Date.now(),
    });

    return {
      success: false,
      data: null,
      errors: [errorMessage],
    };
  }

  /**
   * Create conversion result
   */
  protected createResult(data: unknown, warnings?: string[]): ConversionResult {
    return {
      success: true,
      data,
      warnings,
    };
  }

  /**
   * Clear cache
   */
  public clearCache(): void {
    this.cache.clear();
  }

  /**
   * Get cache statistics
   */
  public getCacheStats(): { size: number; maxSize: number } {
    return {
      size: this.cache.size,
      maxSize: 1000, // Default max size
    };
  }
}
