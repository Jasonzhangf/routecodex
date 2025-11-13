/**
 * RouteCodex Configuration Black Box Integration Tests
 * Tests configuration systems using black box approach
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { BlackBoxTester, SAMPLE_CONFIGS, BLACKBOX_TEST_CASES } from '../../dist/index.js';

describe('Configuration Black Box Tests', () => {
  let blackboxTester;

  it.before(() => {
    blackboxTester = new BlackBoxTester();
  });

  describe('Basic Configuration Validation', () => {
    it('should validate basic configuration successfully', async () => {
      const testCase = BLACKBOX_TEST_CASES[0]; // basic-validation
      const result = await blackboxTester.runTest(testCase);

      assert.strictEqual(result.status, 'passed', 'Basic configuration should be valid');
      assert.ok(result.output, 'Should have normalized output');
      assert.strictEqual(result.output.isValid, true, 'Configuration should be valid');
    });

    it('should handle invalid configuration', async () => {
      const testCase = BLACKBOX_TEST_CASES[2]; // invalid-config-detection
      const result = await blackboxTester.runTest(testCase);

      assert.strictEqual(result.status, 'failed', 'Invalid configuration should fail validation');
      assert.ok(result.output, 'Should have validation output');
      assert.strictEqual(result.output.isValid, false, 'Configuration should be invalid');
      assert.ok(result.output.errors.length > 0, 'Should have validation errors');
    });

    it('should process multi-provider configuration', async () => {
      const testCase = BLACKBOX_TEST_CASES[1]; // multi-provider-validation
      const result = await blackboxTester.runTest(testCase);

      assert.strictEqual(result.status, 'passed', 'Multi-provider configuration should be valid');
      assert.ok(result.output, 'Should have normalized output');
      assert.strictEqual(result.output.isValid, true, 'Configuration should be valid');

      // Check that providers were normalized
      const providers = result.output.normalized?.virtualrouter?.providers;
      assert.ok(providers, 'Should have providers in normalized output');
      assert.ok(Object.keys(providers).length > 1, 'Should have multiple providers');
    });
  });

  describe('Configuration Transformation Tests', () => {
    it('should normalize provider types', async () => {
      const config = {
        ...SAMPLE_CONFIGS.basic,
        virtualrouter: {
          ...SAMPLE_CONFIGS.basic.virtualrouter,
          providers: {
            'glm-provider': {
              id: 'glm-provider',
              type: 'openai',
              enabled: true,
              apiKey: 'test-key',
              baseURL: 'https://open.bigmodel.cn/api/paas/v4',
              compatibility: {
                type: 'glm-compatibility',
                config: {}
              },
              models: {
                'glm-model': {
                  maxTokens: 4096
                }
              }
            }
          },
          routing: {
            'default': ['glm-provider.glm-model'],
            'longcontext': [],
            'thinking': [],
            'background': [],
            'websearch': [],
            'vision': [],
            'coding': [],
            'tools': []
          }
        }
      };

      const test = {
        id: 'glm-normalization',
        name: 'GLM Provider Type Normalization',
        inputConfig: config,
        expectedOutput: {
          isValid: true,
          errors: [],
          warnings: []
        }
      };

      const result = await blackboxTester.runTest(test);

      assert.strictEqual(result.status, 'passed', 'GLM configuration should be normalized');
      assert.ok(result.output, 'Should have normalized output');

      // Check that glm was normalized to glm-http-provider
      const providers = result.output.normalized?.virtualrouter?.providers;
      assert.ok(providers, 'Should have providers in normalized output');
      assert.ok(providers['glm-provider'], 'Should have glm provider');
      assert.strictEqual(
        providers['glm-provider'].type,
        'openai-provider',
        'GLM should be normalized to openai-provider'
      );
    });

    it('should handle environment variable deprecation warnings', async () => {
      // Set test environment variable
      process.env.TEST_API_KEY = 'expanded-key';

      const config = {
        ...SAMPLE_CONFIGS.withEnvVars,
        virtualrouter: {
          ...SAMPLE_CONFIGS.withEnvVars.virtualrouter,
          providers: {
            'env-provider': {
              ...SAMPLE_CONFIGS.withEnvVars.virtualrouter.providers['env-provider'],
              apiKey: '${TEST_API_KEY}'
            }
          }
        }
      };

      const test = {
        id: 'env-deprecation',
        name: 'Environment Variable Deprecation Warnings',
        inputConfig: config,
        expectedOutput: {
          isValid: true,
          errors: [],
          warnings: []
        }
      };

      const result = await blackboxTester.runTest(test);

      assert.strictEqual(result.status, 'passed', 'Configuration with environment variables should be valid');
      assert.ok(result.output, 'Should have normalized output');

      // Check that environment variable is NOT expanded (new behavior)
      const providers = result.output.normalized?.virtualrouter?.providers;
      assert.ok(providers, 'Should have providers in normalized output');
      assert.strictEqual(
        providers['env-provider'].apiKey,
        '${TEST_API_KEY}',
        'Environment variable should NOT be expanded by default'
      );

      // Check that compatibility warnings include API key validation warnings
      assert.ok(result.output.compatibilityWarnings, 'Should have compatibility warnings');
      const apiKeyWarnings = result.output.compatibilityWarnings.filter(w =>
        w.code === 'API_KEY_VALIDATION' && w.message.includes('Environment variable')
      );
      assert.ok(apiKeyWarnings.length > 0, 'Should have API key validation warnings about environment variables');

      // Clean up
      delete process.env.TEST_API_KEY;
    });

    it('should process compatibility configurations', async () => {
      const result = await blackboxTester.runTest({
        id: 'compatibility-processing',
        name: 'Compatibility Configuration Processing',
        inputConfig: SAMPLE_CONFIGS.withCompatibility,
        expectedOutput: {
          isValid: true,
          errors: [],
          warnings: []
        }
      });

      assert.strictEqual(result.status, 'passed', 'Compatibility configuration should be processed');
      assert.ok(result.output, 'Should have compatibility output');
    });
  });

  describe('Error Handling Tests', () => {
    it('should handle malformed JSON', async () => {
      const result = await blackboxTester.runTest({
        id: 'malformed-json',
        name: 'Malformed JSON Handling',
        inputConfig: 'invalid json string',
        expectedOutput: {
          isValid: false,
          errors: [],  // Malformed JSON doesn't even get to validation
          warnings: []
        }
      });

      assert.strictEqual(result.status, 'failed', 'Malformed JSON should fail');
      assert.ok(result.error, 'Should have error information');
    });

    it('should handle missing required fields', async () => {
      const incompleteConfig = {
        version: '1.0.0'
        // Missing required virtualrouter field
      };

      const result = await blackboxTester.runTest({
        id: 'missing-required-fields',
        name: 'Missing Required Fields',
        inputConfig: incompleteConfig,
        expectedOutput: {
          isValid: false,
          errors: [],  // Will have validation errors
          warnings: []
        }
      });

      assert.strictEqual(result.status, 'failed', 'Missing required fields should fail');
      assert.ok(result.output, 'Should have validation output');
      assert.strictEqual(result.output.isValid, false, 'Configuration should be invalid');
    });

    it('should handle invalid routing targets', async () => {
      const configWithInvalidRouting = {
        ...SAMPLE_CONFIGS.basic,
        virtualrouter: {
          ...SAMPLE_CONFIGS.basic.virtualrouter,
          routing: {
            ...SAMPLE_CONFIGS.basic.virtualrouter.routing,
            default: ['nonexistent-provider.nonexistent-model']
          }
        }
      };

      const result = await blackboxTester.runTest({
        id: 'invalid-routing',
        name: 'Invalid Routing Targets',
        inputConfig: configWithInvalidRouting,
        expectedOutput: {
          isValid: false,
          errors: [
            { code: 'UNKNOWN_PROVIDER_IN_ROUTING' }
          ],
          warnings: []
        }
      });

      // This should fail validation with errors about unknown provider
      assert.strictEqual(result.status, 'passed', 'Test should pass (detecting invalid routing correctly)');
      assert.ok(result.output, 'Should have validation output');
      assert.strictEqual(result.output.isValid, false, 'Configuration should be invalid due to unknown provider');

      // Should have errors about invalid routing
      assert.ok(
        result.output.errors.length > 0,
        'Should have errors about invalid routing targets'
      );
      assert.ok(
        result.output.errors.some(e => e.code === 'UNKNOWN_PROVIDER_IN_ROUTING'),
        'Should have UNKNOWN_PROVIDER_IN_ROUTING error'
      );
    });
  });

  describe('Performance Tests', () => {
    it('should process simple configuration quickly', async () => {
      const result = await blackboxTester.runTest({
        id: 'performance-simple',
        name: 'Simple Configuration Performance',
        inputConfig: SAMPLE_CONFIGS.basic,
        expectedOutput: {
          isValid: true,
          errors: [],
          warnings: []
        }
      });

      assert.strictEqual(result.status, 'passed', 'Simple configuration should be processed');
      assert.ok(result.output, 'Should have output');
      assert.strictEqual(result.duration < 100, true, 'Should process simple config in under 100ms');
    });

    it('should handle large configurations efficiently', async () => {
      // Create a base valid config first
      const baseConfig = {
        version: '1.0.0',
        port: 8080,
        virtualrouter: {
          inputProtocol: 'openai',
          outputProtocol: 'openai',
          providers: {
            'main-provider': {
              id: 'main-provider',
              type: 'openai',
              enabled: true,
              apiKey: 'sk-test-key-longer-than-8-chars',
              models: {
                'gpt-3.5-turbo': {
                  maxTokens: 4096
                }
              }
            }
          },
          routing: {
            default: ['main-provider.gpt-3.5-turbo'],
            longcontext: [],
            thinking: [],
            background: [],
            websearch: [],
            vision: [],
            coding: [],
            tools: []
          }
        }
      };

      // Add more providers to make it larger
      const largeConfig = {
        ...baseConfig,
        virtualrouter: {
          ...baseConfig.virtualrouter,
          providers: {
            ...baseConfig.virtualrouter.providers,
            ...Array.from({ length: 20 }, (_, i) => ({
              [`additional-provider-${i}`]: {
                id: `additional-provider-${i}`,
                type: 'openai',
                enabled: true,
                apiKey: `sk-test-key-longer-than-8-chars-${i}`,
                models: {
                  [`model-${i}`]: {
                    maxTokens: 4096
                  }
                }
              }
            })).reduce((acc, provider) => ({ ...acc, ...provider }), {})
          }
        }
      };

      const result = await blackboxTester.runTest({
        id: 'performance-large',
        name: 'Large Configuration Performance',
        inputConfig: largeConfig,
        expectedOutput: {
          isValid: true,
          errors: [],
          warnings: []
        }
      });

      assert.strictEqual(result.status, 'passed', 'Large configuration should be processed');
      assert.ok(result.output, 'Should have output');
      assert.strictEqual(result.duration < 1000, true, 'Should process large config in under 1s');
    });
  });

  describe('Compatibility Layer Tests', () => {
    it('should apply provider type normalization', async () => {
      const config = {
        version: '1.0.0',
        port: 8080,
        virtualrouter: {
          inputProtocol: 'openai',
          outputProtocol: 'openai',
          providers: {
            'lmstudio': {
              id: 'lmstudio',
              type: 'lmstudio',
              enabled: true,
              apiKey: 'test-key-longer-than-8-chars',
              baseURL: 'http://localhost:1234',
              models: {
                'model': {
                  maxTokens: 4096
                }
              }
            }
          },
          routing: {
            default: ['lmstudio.model'],
            longcontext: [],
            thinking: [],
            background: [],
            websearch: [],
            vision: [],
            coding: [],
            tools: []
          }
        }
      };

      const result = await blackboxTester.runTest({
        id: 'lmstudio-normalization',
        name: 'LMStudio Provider Normalization',
        inputConfig: config,
        expectedOutput: {
          isValid: true,
          errors: [],
          warnings: []
        }
      });

      assert.strictEqual(result.status, 'passed', 'LMStudio configuration should be normalized');
      assert.ok(result.output, 'Should have normalized output');

      const providers = result.output.normalized?.virtualrouter?.providers;
      assert.ok(providers, 'Should have providers in normalized output');
      assert.strictEqual(
        providers['lmstudio'].type,
        'lmstudio-http',
        'LMStudio should be normalized to lmstudio-http'
      );
    });

    it('should handle OAuth configurations', async () => {
      const oauthConfig = {
        version: '1.0.0',
        port: 8080,
        virtualrouter: {
          inputProtocol: 'openai',
          outputProtocol: 'openai',
          providers: {
            'oauth-provider': {
              id: 'oauth-provider',
              type: 'iflow',
              enabled: true,
              apiKey: 'sk-test-key-longer-than-8-chars',
              models: {
                'oauth-model': {
                  maxTokens: 4096
                }
              }
            }
          },
          routing: {
            default: ['oauth-provider.oauth-model'],
            longcontext: [],
            thinking: [],
            background: [],
            websearch: [],
            vision: [],
            coding: [],
            tools: []
          }
        }
      };

      const result = await blackboxTester.runTest({
        id: 'oauth-configuration',
        name: 'OAuth Configuration Processing',
        inputConfig: oauthConfig,
        expectedOutput: {
          isValid: true,
          errors: [],
          warnings: []
        }
      });

      assert.strictEqual(result.status, 'passed', 'OAuth configuration should be processed');
      assert.ok(result.output, 'Should have compatibility output');
    });

    it('should handle thinking mode configurations', async () => {
      const thinkingConfig = {
        version: '1.0.0',
        port: 8080,
        virtualrouter: {
          inputProtocol: 'openai',
          outputProtocol: 'openai',
          providers: {
            'thinking-provider': {
              id: 'thinking-provider',
              type: 'qwen',
              enabled: true,
              apiKey: 'sk-test-key-longer-than-8-chars',
              models: {
                'thinking-model': {
                  maxTokens: 4096,
                  thinking: {
                    enabled: true,
                    payload: {
                      type: 'enabled'
                    }
                  }
                }
              }
            }
          },
          routing: {
            default: ['thinking-provider.thinking-model'],
            longcontext: [],
            thinking: [],
            background: [],
            websearch: [],
            vision: [],
            coding: [],
            tools: []
          }
        }
      };

      const result = await blackboxTester.runTest({
        id: 'thinking-configuration',
        name: 'Thinking Mode Configuration',
        inputConfig: thinkingConfig,
        expectedOutput: {
          isValid: true,
          errors: [],
          warnings: []
        }
      });

      assert.strictEqual(result.status, 'passed', 'Thinking configuration should be processed');
      assert.ok(result.output, 'Should have compatibility output');
    });
  });
});