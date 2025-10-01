/**
 * RouteCodex Black Box Testing Framework
 * Tests configuration systems without internal knowledge
 */

import { ConfigParser } from 'routecodex-config-engine';
import { CompatibilityEngine } from 'routecodex-config-compat';
import type {
  BlackBoxTest,
  TestEnvironment,
  TestCondition,
  TestResult,
  TestError,
  TestUtilities
} from '../types/testkit-types.js';

export class BlackBoxTester {
  private configParser: ConfigParser;
  private compatibilityEngine: CompatibilityEngine;
  private utilities: TestUtilities;

  constructor() {
    this.configParser = new ConfigParser();
    this.compatibilityEngine = new CompatibilityEngine();
    this.utilities = this.createTestUtilities();
  }

  /**
   * Run a black box test
   */
  async runTest(test: BlackBoxTest, environment?: TestEnvironment): Promise<TestResult> {
    const startTime = Date.now();

    try {
      // Set up test environment
      await this.setupEnvironment(environment || test.environment);

      // Check preconditions
      if (test.preconditions) {
        await this.checkConditions(test.preconditions);
      }

      // Handle malformed JSON input
      let configString: string;
      let parsedInput: any;

      if (typeof test.inputConfig === 'string') {
        // If input is a string, try to parse it as JSON
        try {
          parsedInput = JSON.parse(test.inputConfig);
          configString = test.inputConfig;
        } catch (parseError) {
          // Malformed JSON - return error result
          return {
            id: test.id,
            name: test.name,
            status: 'failed',
            duration: Date.now() - startTime,
            error: {
              type: 'MALFORMED_JSON',
              message: 'Input is not valid JSON',
              stack: parseError instanceof Error ? parseError.stack : undefined,
              context: {
                details: parseError instanceof Error ? parseError.message : String(parseError)
              }
            },
            output: {
              isValid: false,
              errors: [{
                code: 'MALFORMED_JSON',
                message: 'Input is not valid JSON',
                path: '',
                expected: 'Valid JSON string'
              }],
              warnings: []
            }
          };
        }
      } else {
        // Input is already an object, stringify it
        parsedInput = test.inputConfig;
        configString = JSON.stringify(test.inputConfig);
      }

      // Apply compatibility transformations first (always apply to normalize configuration)
      const compatibilityResult = await this.compatibilityEngine.processCompatibility(configString);

      // Validate the transformed configuration
      const validationResult = compatibilityResult.isValid
        ? await this.configParser.parseFromString(
            JSON.stringify(compatibilityResult.compatibilityConfig?.normalizedConfig || test.inputConfig)
          )
        : compatibilityResult;

      // Validate output against expectations
      const output = this.normalizeOutput(compatibilityResult);
      const validationSuccess = this.validateOutput(output, test.expectedOutput);

      // Check postconditions
      if (test.postconditions) {
        await this.checkConditions(test.postconditions);
      }

      return {
        id: test.id,
        name: test.name,
        status: validationSuccess ? 'passed' : 'failed',
        duration: Date.now() - startTime,
        output
      };

    } catch (error) {
      return {
        id: test.id,
        name: test.name,
        status: 'failed',
        duration: Date.now() - startTime,
        error: this.normalizeError(error)
      };
    } finally {
      await this.cleanupEnvironment();
    }
  }

  /**
   * Run multiple black box tests
   */
  async runTests(tests: BlackBoxTest[], environment?: TestEnvironment): Promise<TestResult[]> {
    const results: TestResult[] = [];

    for (const test of tests) {
      results.push(await this.runTest(test, environment));
    }

    return results;
  }

  /**
   * Set up test environment
   */
  private async setupEnvironment(environment?: TestEnvironment): Promise<void> {
    if (!environment) {
      return;
    }

    // Set environment variables
    if (environment.variables) {
      for (const [key, value] of Object.entries(environment.variables)) {
        process.env[key] = value;
      }
    }

    // Set up mock services if needed
    if (environment.mockServices) {
      for (const [serviceName, serviceConfig] of Object.entries(environment.mockServices)) {
        await this.setupMockService(serviceName, serviceConfig);
      }
    }
  }

  /**
   * Clean up test environment
   */
  private async cleanupEnvironment(): Promise<void> {
    // Restore environment variables
    // Note: In a real implementation, you'd save and restore original values
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('TEST_')) {
        delete process.env[key];
      }
    }
  }

  /**
   * Check test conditions
   */
  private async checkConditions(conditions: TestCondition[]): Promise<void> {
    for (const condition of conditions) {
      const result = await this.evaluateCondition(condition);
      if (!result) {
        throw new Error(`Condition failed: ${JSON.stringify(condition)}`);
      }
    }
  }

  /**
   * Evaluate a single condition
   */
  private async evaluateCondition(condition: TestCondition): Promise<boolean> {
    switch (condition.type) {
      case 'file-exists':
        return this.checkFileExists(condition.value);

      case 'env-var':
        return this.checkEnvironmentVariable(condition.value, condition.operator);

      case 'service-available':
        return this.checkServiceAvailable(condition.value);

      case 'config-valid':
        return this.checkConfigValid(condition.value);

      default:
        throw new Error(`Unknown condition type: ${condition.type}`);
    }
  }

  /**
   * Check if file exists
   */
  private async checkFileExists(filePath: string): Promise<boolean> {
    try {
      const fs = await import('fs');
      return fs.existsSync(filePath);
    } catch {
      return false;
    }
  }

  /**
   * Check environment variable
   */
  private checkEnvironmentVariable(varName: string, operator: string): boolean {
    const value = process.env[varName];

    switch (operator) {
      case 'exists':
        return value !== undefined;
      case 'equals':
        return value === varName; // Note: This might need adjustment
      default:
        return false;
    }
  }

  /**
   * Check if service is available
   */
  private async checkServiceAvailable(serviceUrl: string): Promise<boolean> {
    try {
      const response = await fetch(serviceUrl, { method: 'HEAD' });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Check if configuration is valid
   */
  private async checkConfigValid(config: any): Promise<boolean> {
    try {
      const result = await this.configParser.validate(config);
      return result.isValid;
    } catch {
      return false;
    }
  }

  /**
   * Set up mock service
   */
  private async setupMockService(serviceName: string, serviceConfig: any): Promise<void> {
    // This would implement mock service setup
    // For now, it's a placeholder
    console.log(`Setting up mock service: ${serviceName}`, serviceConfig);
  }

  /**
   * Normalize test output for comparison
   */
  private normalizeOutput(result: any): any {
    // Remove dynamic fields that change between runs
    const normalized = JSON.parse(JSON.stringify(result));

    // Extract normalized config to top level for easier testing
    if (normalized.compatibilityConfig?.normalizedConfig) {
      normalized.normalized = normalized.compatibilityConfig.normalizedConfig;

      // Extract keyAliases from providers to top level if it exists
      if (normalized.normalized.virtualrouter?.providers) {
        const providerEntries = Object.entries(normalized.normalized.virtualrouter.providers);
        if (providerEntries.length > 0) {
          const firstProvider = providerEntries[0][1] as any;
          if (firstProvider.keyAliases) {
            normalized.keyAliases = firstProvider.keyAliases;
          }
        }
      }
    }

    // Remove warnings that might vary
    if (normalized.compatibilityWarnings) {
      normalized.compatibilityWarnings = normalized.compatibilityWarnings.filter(
        (warning: any) => !warning.message.includes('timestamp')
      );
    }
    return normalized;
  }

  /**
   * Validate output against expected
   */
  private validateOutput(actual: any, expected: any): boolean {
    // Check the core validation result fields
    if (actual.isValid !== expected.isValid) {
      return false;
    }

    // Check errors length and content
    if (!Array.isArray(actual.errors) || !Array.isArray(expected.errors)) {
      return false;
    }
    if (actual.errors.length !== expected.errors.length) {
      return false;
    }

    // Check warnings length (actual may have more warnings due to compatibility processing)
    if (!Array.isArray(actual.warnings) || !Array.isArray(expected.warnings)) {
      return false;
    }
    if (actual.warnings.length < expected.warnings.length) {
      return false;
    }

    // Check top-level keyAliases field if expected has it
    if (expected.keyAliases !== undefined) {
      if (!Array.isArray(actual.keyAliases) || !Array.isArray(expected.keyAliases)) {
        return false;
      }
      if (JSON.stringify(actual.keyAliases) !== JSON.stringify(expected.keyAliases)) {
        return false;
      }
    }

    // Check normalized config contains expected fields
    if (expected.normalized && actual.normalized) {
      return this.containsExpectedFields(actual.normalized, expected.normalized);
    }

    return true;
  }

  /**
   * Check if actual object contains all expected fields with matching values
   */
  private containsExpectedFields(actual: any, expected: any): boolean {
    for (const [key, value] of Object.entries(expected)) {
      if (!(key in actual)) {
        return false;
      }

      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        if (typeof actual[key] !== 'object' || actual[key] === null) {
          return false;
        }
        if (!this.containsExpectedFields(actual[key], value)) {
          return false;
        }
      } else if (Array.isArray(value)) {
        if (!Array.isArray(actual[key])) {
          return false;
        }
        if (actual[key].length !== value.length) {
          return false;
        }
        for (let i = 0; i < value.length; i++) {
          if (actual[key][i] !== value[i]) {
            return false;
          }
        }
      } else {
        if (actual[key] !== value) {
          return false;
        }
      }
    }
    return true;
  }

  /**
   * Deep equality comparison with options
   */
  private deepEqual(actual: any, expected: any, options: any): boolean {
    if (actual === expected) return true;

    if (typeof actual !== typeof expected) return false;

    if (typeof actual !== 'object' || actual === null || expected === null) {
      return false;
    }

    // Handle arrays
    if (Array.isArray(actual) && Array.isArray(expected)) {
      if (actual.length !== expected.length) return false;

      for (let i = 0; i < actual.length; i++) {
        if (!this.deepEqual(actual[i], expected[i], options)) return false;
      }

      return true;
    }

    // Handle objects
    const actualKeys = Object.keys(actual);
    const expectedKeys = Object.keys(expected);

    if (actualKeys.length !== expectedKeys.length) return false;

    for (const key of actualKeys) {
      if (!expectedKeys.includes(key)) return false;

      // Skip ignored paths
      if (options.ignorePaths && options.ignorePaths.includes(key)) continue;

      if (!this.deepEqual(actual[key], expected[key], options)) return false;
    }

    return true;
  }

  /**
   * Normalize error for reporting
   */
  private normalizeError(error: any): TestError {
    if (error instanceof Error) {
      return {
        type: error.constructor.name,
        message: error.message,
        stack: error.stack
      };
    }

    return {
      type: 'UnknownError',
      message: String(error)
    };
  }

  /**
   * Create test utilities
   */
  private createTestUtilities(): TestUtilities {
    return {
      createMockConfig: (overrides?: any) => {
        const baseConfig = {
          version: '1.0.0',
          port: 8080,
          virtualrouter: {
            inputProtocol: 'openai',
            outputProtocol: 'openai',
            providers: {
              'test-provider': {
                type: 'openai',
                enabled: true,
                apiKey: 'test-key',
                models: {
                  'test-model': {
                    maxTokens: 4096
                  }
                }
              }
            },
            routing: {
              default: ['test-provider.test-model']
            }
          }
        };

        return this.deepMerge(baseConfig, overrides);
      },

      createValidationError: (message: string, path?: string) => ({
        code: 'TEST_VALIDATION_ERROR',
        message,
        path: path || ''
      }),

      createCompatibilityWarning: (message: string, path?: string) => ({
        code: 'TEST_COMPATIBILITY_WARNING',
        message,
        path: path || '',
        severity: 'info' as const
      }),

      waitForCondition: async (condition: () => boolean, timeout = 5000) => {
        const start = Date.now();

        while (Date.now() - start < timeout) {
          if (condition()) return true;
          await new Promise(resolve => setTimeout(resolve, 100));
        }

        return false;
      },

      measurePerformance: async (fn: () => Promise<any>) => {
        const start = Date.now();
        const result = await fn();
        const duration = Date.now() - start;

        return { duration, result };
      }
    };
  }

  /**
   * Deep merge objects
   */
  private deepMerge(target: any, source: any): any {
    if (typeof target !== 'object' || target === null) return source;
    if (typeof source !== 'object' || source === null) return target;

    const output = { ...target };

    for (const key in source) {
      if (source.hasOwnProperty(key)) {
        if (typeof source[key] === 'object' && source[key] !== null) {
          output[key] = this.deepMerge(target[key], source[key]);
        } else {
          output[key] = source[key];
        }
      }
    }

    return output;
  }

  /**
   * Get test utilities
   */
  getUtilities(): TestUtilities {
    return this.utilities;
  }
}