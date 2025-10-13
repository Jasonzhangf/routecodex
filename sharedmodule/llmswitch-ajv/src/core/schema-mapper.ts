/**
 * AJV-based Schema Mapper for LLMSwitch
 * Provides validation and conversion capabilities using JSON Schema
 */

import Ajv, { ValidateFunction, ErrorObject } from 'ajv';
// import addFormats from 'ajv-formats';
import type {
  JsonSchema,
  ValidationResult,
  SchemaCacheEntry,
  PerformanceMetrics,
  ConversionDirection
} from '../types/index.js';
import {
  openAIChatRequestSchema,
  openAIChatResponseSchema,
  anthropicMessageRequestSchema,
  anthropicMessageResponseSchema,
  commonToolSchemas
} from '../schemas/index.js';

/**
 * AJV Schema Mapper
 *
 * Core responsibilities:
 * - Compile and cache JSON schemas for performance
 * - Validate data against schemas
 * - Provide detailed error reporting
 * - Track performance metrics
 */
export class AjvSchemaMapper {
  private ajv: any; // Ajv instance
  private schemaCache: Map<string, SchemaCacheEntry> = new Map();
  private metrics: PerformanceMetrics = {
    conversionTime: 0,
    validationTime: 0,
    totalTime: 0,
    schemaCacheHits: 0,
    schemaCacheMisses: 0,
    errorCount: 0
  };

  constructor() {
    // Initialize AJV with performance-oriented settings
    this.ajv = new Ajv({
      allErrors: true,           // Collect all validation errors
      verbose: true,            // Include detailed error information
      removeAdditional: true,   // Remove additional properties
      coerceTypes: true,        // Auto-coerce types when possible
      strict: false,            // Allow additional properties for compatibility
      useDefaults: true,        // Apply default values from schema
      addUsedSchema: false,     // Manual schema management for better control
    } as any);

    // Add format validation support - disabled for compatibility
    // addFormats(this.ajv);

    // Pre-compile common schemas
    this.precompileCommonSchemas();
  }

  /**
   * Validate data against a predefined schema
   */
  validate(schemaName: string, data: any): ValidationResult {
    const schema = this.getPredefinedSchema(schemaName);
    if (!schema) {
      throw new Error(`Unknown predefined schema: ${schemaName}`);
    }
    return this.validateWithSchema(data, schema);
  }

  /**
   * Validate data against a custom schema
   */
  validateWithSchema(data: any, schema: JsonSchema): ValidationResult {
    const startTime = performance.now();

    try {
      const validateFn = this.getOrCompileSchema(schema);
      const valid = validateFn(data);
      const endTime = performance.now();

      // Update metrics
      this.metrics.validationTime += (endTime - startTime);
      this.metrics.totalTime += (endTime - startTime);

      if (!valid) {
        this.metrics.errorCount++;
      }

      return {
        valid: !!valid,
        data: valid ? data : undefined,
        errors: valid ? undefined : this.formatErrors(validateFn.errors || [])
      };
    } catch (error) {
      const endTime = performance.now();
      this.metrics.validationTime += (endTime - startTime);
      this.metrics.totalTime += (endTime - startTime);
      this.metrics.errorCount++;

      return {
        valid: false,
        errors: [{
          instancePath: '',
          schemaPath: '',
          keyword: 'error',
          params: {},
          message: `Validation error: ${(error as Error).message}`
        }]
      };
    }
  }

  /**
   * Validate and normalize tool parameters
   */
  validateToolParameters(toolName: string, parameters: any, direction: ConversionDirection): ValidationResult {
    // Try to get predefined schema for common tools
    const schemaKey = toolName.toLowerCase();
    const schema = commonToolSchemas[schemaKey];

    if (schema) {
      return this.validateWithSchema(parameters, schema);
    }

    // If no predefined schema, perform basic validation
    return this.validateBasicToolParameters(parameters, toolName);
  }

  /**
   * Validate OpenAI chat request
   */
  validateOpenAIRequest(request: any): ValidationResult {
    return this.validate('openAIChatRequest', request);
  }

  /**
   * Validate OpenAI chat response
   */
  validateOpenAIResponse(response: any): ValidationResult {
    return this.validate('openAIChatResponse', response);
  }

  /**
   * Validate Anthropic message request
   */
  validateAnthropicRequest(request: any): ValidationResult {
    return this.validate('anthropicMessageRequest', request);
  }

  /**
   * Validate Anthropic message response
   */
  validateAnthropicResponse(response: any): ValidationResult {
    return this.validate('anthropicMessageResponse', response);
  }

  /**
   * Get current performance metrics
   */
  getMetrics(): PerformanceMetrics {
    return { ...this.metrics };
  }

  /**
   * Reset performance metrics
   */
  resetMetrics(): void {
    this.metrics = {
      conversionTime: 0,
      validationTime: 0,
      totalTime: 0,
      schemaCacheHits: 0,
      schemaCacheMisses: 0,
      errorCount: 0
    };
  }

  /**
   * Clear schema cache
   */
  clearCache(): void {
    this.schemaCache.clear();
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): {
    size: number;
    hitRate: number;
    totalUses: number;
  } {
    const totalUses = this.metrics.schemaCacheHits + this.metrics.schemaCacheMisses;
    return {
      size: this.schemaCache.size,
      hitRate: totalUses > 0 ? this.metrics.schemaCacheHits / totalUses : 0,
      totalUses
    };
  }

  /**
   * Precompile common schemas for better performance
   */
  private precompileCommonSchemas(): void {
    const commonSchemas = [
      { name: 'openAIChatRequest', schema: openAIChatRequestSchema },
      { name: 'openAIChatResponse', schema: openAIChatResponseSchema },
      { name: 'anthropicMessageRequest', schema: anthropicMessageRequestSchema },
      { name: 'anthropicMessageResponse', schema: anthropicMessageResponseSchema },
      ...Object.entries(commonToolSchemas).map(([name, schema]) => ({ name: `tool:${name}`, schema }))
    ];

    commonSchemas.forEach(({ name, schema }) => {
      try {
        this.getOrCompileSchema(schema, name);
      } catch (error) {
        console.warn(`Failed to precompile schema ${name}:`, error);
      }
    });
  }

  /**
   * Get or compile a schema, using cache for performance
   */
  private getOrCompileSchema(schema: JsonSchema, cacheKey?: string): ValidateFunction {
    const key = cacheKey || JSON.stringify(schema);

    // Check cache first
    const cached = this.schemaCache.get(key);
    if (cached) {
      this.metrics.schemaCacheHits++;
      cached.lastUsed = Date.now();
      cached.useCount++;
      return cached.validateFunction;
    }

    // Compile new schema
    const startTime = performance.now();
    const validateFn = this.ajv.compile(schema);
    const endTime = performance.now();

    // Cache the compiled schema
    this.schemaCache.set(key, {
      validateFunction: validateFn,
      lastUsed: Date.now(),
      useCount: 1
    });

    this.metrics.schemaCacheMisses++;
    this.metrics.conversionTime += (endTime - startTime);

    return validateFn;
  }

  /**
   * Get predefined schema by name
   */
  private getPredefinedSchema(name: string): JsonSchema | undefined {
    const schemaMap: Record<string, JsonSchema> = {
      openAIChatRequest: openAIChatRequestSchema,
      openAIChatResponse: openAIChatResponseSchema,
      anthropicMessageRequest: anthropicMessageRequestSchema,
      anthropicMessageResponse: anthropicMessageResponseSchema,
      ...commonToolSchemas
    };

    return schemaMap[name];
  }

  /**
   * Basic validation for tools without predefined schemas
   */
  private validateBasicToolParameters(parameters: any, toolName: string): ValidationResult {
    if (!parameters || typeof parameters !== 'object') {
      return {
        valid: false,
        errors: [{
          instancePath: '',
          schemaPath: '',
          keyword: 'type',
          params: { type: 'object' },
          message: `Tool parameters must be an object for ${toolName}`
        }]
      };
    }

    if (Array.isArray(parameters)) {
      // Convert arrays to objects if they contain objects
      const objects = parameters.filter(item =>
        item && typeof item === 'object' && !Array.isArray(item)
      );

      if (objects.length > 0) {
        const merged = objects.reduce((acc, obj) => ({ ...acc, ...obj }), {});
        return { valid: true, data: merged };
      }

      return {
        valid: false,
        errors: [{
          instancePath: '',
          schemaPath: '',
          keyword: 'type',
          params: { type: 'object' },
          message: `Tool parameters array must contain objects for ${toolName}`
        }]
      };
    }

    return { valid: true, data: parameters };
  }

  /**
   * Format AJV errors into a more readable format
   */
  private formatErrors(errors: any[]): Array<{
    instancePath: string;
    schemaPath: string;
    keyword: string;
    params: Record<string, any>;
    message?: string;
  }> {
    return errors.map((error: any) => ({
      instancePath: error.instancePath || '',
      schemaPath: error.schemaPath || '',
      keyword: error.keyword || '',
      params: error.params || {},
      message: error.message || ''
    }));
  }

  /**
   * Clean up old cache entries to prevent memory leaks
   */
  cleanupCache(maxAge: number = 3600000): void { // Default 1 hour
    const now = Date.now();
    const toDelete: string[] = [];

    this.schemaCache.forEach((entry, key) => {
      if (now - entry.lastUsed > maxAge) {
        toDelete.push(key);
      }
    });

    toDelete.forEach(key => this.schemaCache.delete(key));
  }
}