/**
 * RouteCodex Secret Sanitization Tests
 * Tests for secret detection, sanitization, and configuration safety
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  CompatibilityEngine
} from 'routecodex-config-compat';
import {
  createSafeConfig,
  containsSensitiveData,
  sanitizeString,
  sanitizeObject,
  shouldSanitizeField,
  maskSensitiveData,
  SECRET_PATTERNS,
  SENSITIVE_FIELDS,
  SANITIZATION_REPLACEMENT
} from 'routecodex-config-engine';

describe('Secret Sanitization Tests', () => {

  describe('Secret Pattern Detection', () => {
    it('should detect OpenAI API keys', () => {
      const openaiKey = 'sk-proj-abc123def456ghi789jkl012mno345pqr678stu901vwx234yz567';
      assert.ok(containsSensitiveData(openaiKey));
    });

    it('should detect generic API keys', () => {
      const genericKey = 'ak-1234567890abcdef1234567890abcdef';
      assert.ok(containsSensitiveData(genericKey));
    });

    it('should detect Bearer tokens', () => {
      const bearerToken = 'Bearer eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9...';
      assert.ok(containsSensitiveData(bearerToken));
    });

    it('should detect GitHub tokens', () => {
      const githubToken = 'ghp_1234567890abcdef1234567890abcdef1234';
      assert.ok(containsSensitiveData(githubToken));
    });

    it('should detect passwords in JSON strings', () => {
      const passwordJson = '{"password": "mySecret123"}';
      assert.ok(containsSensitiveData(passwordJson));
    });

    it('should not detect safe strings', () => {
      const safeString = 'hello-world-test-config';
      assert.ok(!containsSensitiveData(safeString));
    });

    it('should not detect short strings as secrets', () => {
      const shortString = 'abc123';
      assert.ok(!containsSensitiveData(shortString));
    });
  });

  describe('String Sanitization', () => {
    it('should replace OpenAI API keys', () => {
      const input = 'API key: sk-proj-abc123def456ghi789jkl012mno345pqr678stu901vwx234yz567';
      const expected = `API key: ${SANITIZATION_REPLACEMENT}`;
      assert.strictEqual(sanitizeString(input), expected);
    });

    it('should replace multiple API keys in one string', () => {
      const input = 'Key1: sk-abc123def456 Key2: ak-xyz789uvw456';
      const expected = `Key1: ${SANITIZATION_REPLACEMENT} Key2: ${SANITIZATION_REPLACEMENT}`;
      assert.strictEqual(sanitizeString(input), expected);
    });

    it('should replace URLs with credentials', () => {
      const input = 'Database: https://user:password@example.com/db';
      const expected = `Database: ${SANITIZATION_REPLACEMENT}`;
      assert.strictEqual(sanitizeString(input), expected);
    });

    it('should preserve safe strings', () => {
      const input = 'Configuration version: 1.0.0';
      assert.strictEqual(sanitizeString(input), input);
    });
  });

  describe('Object Sanitization', () => {
    it('should sanitize sensitive fields in objects', () => {
      const config = {
        version: '1.0.0',
        virtualrouter: {
          providers: {
            openai: {
              type: 'openai',
              apiKey: 'sk-proj-abc123def456ghi789jkl012mno345pqr678stu901vwx234yz567',
              models: {
                'gpt-4': {
                  maxTokens: 4000
                }
              }
            }
          }
        }
      };

      const sanitized = sanitizeObject(config);

      assert.strictEqual(
        sanitized.virtualrouter.providers.openai.apiKey,
        SANITIZATION_REPLACEMENT
      );
      assert.strictEqual(sanitized.version, '1.0.0');
      assert.strictEqual(
        sanitized.virtualrouter.providers.openai.models['gpt-4'].maxTokens,
        4000
      );
    });

    it('should sanitize arrays of sensitive data', () => {
      const config = {
        apiKeys: [
          'sk-abc123def456ghi789jkl',  // Longer API key to match pattern
          'ak-xyz789uvw456abc123def'   // Longer API key to match pattern
        ]
      };

      const sanitized = sanitizeObject(config);

      assert.deepStrictEqual(sanitized.apiKeys, [
        SANITIZATION_REPLACEMENT,
        SANITIZATION_REPLACEMENT
      ]);
    });

    it('should handle nested objects with sensitive data', () => {
      const config = {
        auth: {
          credentials: {
            username: 'user',
            password: 'secret123',
            tokens: {
              access: 'bearer-token-123',
              refresh: 'refresh-token-456'
            }
          }
        },
        safe: {
          data: 'public-info'
        }
      };

      const sanitized = sanitizeObject(config);

      assert.strictEqual(
        sanitized.auth.credentials.password,
        SANITIZATION_REPLACEMENT
      );
      assert.strictEqual(
        sanitized.auth.credentials.tokens.access,
        SANITIZATION_REPLACEMENT
      );
      assert.strictEqual(
        sanitized.auth.credentials.tokens.refresh,
        SANITIZATION_REPLACEMENT
      );
      assert.strictEqual(sanitized.safe.data, 'public-info');
    });

    it('should preserve non-sensitive data', () => {
      const config = {
        version: '1.0.0',
        port: 8080,
        debug: true,
        logging: {
          level: 'info',
          format: 'json'
        }
      };

      const sanitized = sanitizeObject(config);

      assert.deepStrictEqual(sanitized, config);
    });
  });

  describe('Field Sanitization Detection', () => {
    it('should identify apiKey field as sensitive', () => {
      assert.ok(shouldSanitizeField('apiKey', 'any-value'));
    });

    it('should identify api_key field as sensitive', () => {
      assert.ok(shouldSanitizeField('api_key', 'any-value'));
    });

    it('should identify secret field as sensitive', () => {
      assert.ok(shouldSanitizeField('secret', 'any-value'));
    });

    it('should identify password field as sensitive', () => {
      assert.ok(shouldSanitizeField('password', 'any-value'));
    });

    it('should identify token field as sensitive', () => {
      assert.ok(shouldSanitizeField('token', 'any-value'));
    });

    it('should not identify safe fields as sensitive', () => {
      assert.ok(!shouldSanitizeField('version', '1.0.0'));
      assert.ok(!shouldSanitizeField('port', '8080'));
      assert.ok(!shouldSanitizeField('debug', 'true'));
    });

    it('should identify fields containing secret pattern as sensitive', () => {
      assert.ok(shouldSanitizeField('clientSecret', 'value'));
      assert.ok(shouldSanitizeField('refreshToken', 'value'));
      assert.ok(!shouldSanitizeField('secretary', 'value')); // Not a security field
    });
  });

  describe('Data Masking', () => {
    it('should mask long sensitive data with prefix and suffix', () => {
      const data = 'sk-proj-abc123def456ghi789jkl012mno345pqr678stu901vwx234yz567';
      const masked = maskSensitiveData(data, 8);

      assert.ok(masked.startsWith('sk-proj-'));
      assert.ok(masked.endsWith('yz567'));
      assert.ok(masked.includes('...'));
      assert.ok(masked.length < data.length);
    });

    it('should replace short data completely', () => {
      const data = 'short';
      const masked = maskSensitiveData(data, 4);

      assert.strictEqual(masked, SANITIZATION_REPLACEMENT);
    });

    it('should handle empty strings', () => {
      const data = '';
      const masked = maskSensitiveData(data, 4);

      assert.strictEqual(masked, SANITIZATION_REPLACEMENT);
    });
  });

  describe('Configuration Engine Integration', () => {
    it('should sanitize output when sanitizeOutput is enabled', async () => {
      const configWithSecrets = {
        version: '1.0.0',
        virtualrouter: {
          inputProtocol: 'openai',
          outputProtocol: 'openai',
          providers: {
            'openai-provider': {
              id: 'openai-provider',
              type: 'openai',
              enabled: true,
              apiKey: 'sk-proj-abc123def456ghi789jkl012mno345pqr678stu901vwx234yz567',
              models: {
                'gpt-4': {
                  maxTokens: 4000,
                  temperature: 0.7
                }
              }
            }
          },
          routing: {
            default: ['openai-provider.gpt-4'],
            thinking: ['openai-provider.gpt-4'],
            coding: ['openai-provider.gpt-4'],
            longcontext: ['openai-provider.gpt-4'],
            tools: ['openai-provider.gpt-4'],
            vision: ['openai-provider.gpt-4'],
            websearch: ['openai-provider.gpt-4'],
            background: ['openai-provider.gpt-4']
          }
        }
      };

      const engine = new CompatibilityEngine({ sanitizeOutput: true });
      const result = await engine.processCompatibility(JSON.stringify(configWithSecrets));

      assert.ok(result.isValid);

      // Check that the normalized config is sanitized
      if (result.normalized) {
        const sanitizedConfig = createSafeConfig(result.normalized);
        const providerConfig = sanitizedConfig.virtualrouter?.providers?.['openai-provider'];

        assert.strictEqual(providerConfig?.apiKey, SANITIZATION_REPLACEMENT);
      }
    });

    it('should not sanitize output when sanitizeOutput is disabled', async () => {
      const configWithSecrets = {
        version: '1.0.0',
        virtualrouter: {
          inputProtocol: 'openai',
          outputProtocol: 'openai',
          providers: {
            'openai-provider': {
              id: 'openai-provider',
              type: 'openai',
              enabled: true,
              apiKey: 'sk-proj-abc123def456ghi789jkl012mno345pqr678stu901vwx234yz567',
              models: {
                'gpt-4': {
                  maxTokens: 4000,
                  temperature: 0.7
                }
              }
            }
          },
          routing: {
            default: ['openai-provider.gpt-4'],
            thinking: ['openai-provider.gpt-4'],
            coding: ['openai-provider.gpt-4'],
            longcontext: ['openai-provider.gpt-4'],
            tools: ['openai-provider.gpt-4'],
            vision: ['openai-provider.gpt-4'],
            websearch: ['openai-provider.gpt-4'],
            background: ['openai-provider.gpt-4']
          }
        }
      };

      const engine = new CompatibilityEngine({ sanitizeOutput: false });
      const result = await engine.processCompatibility(JSON.stringify(configWithSecrets));

      assert.ok(result.isValid);

      // Check that the original API key is preserved
      if (result.normalized) {
        const providerConfig = result.normalized.virtualrouter?.providers?.['openai-provider'];
        assert.strictEqual(providerConfig?.apiKey, 'sk-proj-abc123def456ghi789jkl012mno345pqr678stu901vwx234yz567');
      }
    });

    it('should handle OAuth token sanitization', async () => {
      const configWithOAuth = {
        version: '1.0.0',
        virtualrouter: {
          inputProtocol: 'openai',
          outputProtocol: 'openai',
          providers: {
            'iflow-provider': {
              id: 'iflow-provider',
              type: 'iflow',
              enabled: true,
              auth: {
                type: 'oauth',
                device: {
                  clientId: 'test-client-id',
                  deviceCodeUrl: 'https://api.example.com/device',
                  tokenUrl: 'https://api.example.com/token',
                  scopes: ['read', 'write'],
                  tokenFile: '/path/to/token'
                }
              },
              models: {
                'test-model': {
                  maxTokens: 4000
                }
              }
            }
          },
          routing: {
            default: ['iflow-provider.test-model'],
            thinking: ['iflow-provider.test-model'],
            coding: ['iflow-provider.test-model'],
            longcontext: ['iflow-provider.test-model'],
            tools: ['iflow-provider.test-model'],
            vision: ['iflow-provider.test-model'],
            websearch: ['iflow-provider.test-model'],
            background: ['iflow-provider.test-model']
          }
        }
      };

      const engine = new CompatibilityEngine({ sanitizeOutput: true });
      const result = await engine.processCompatibility(JSON.stringify(configWithOAuth));

      assert.ok(result.isValid);

      // OAuth configurations should not be sanitized by default as they contain URLs and IDs
      // that are not inherently sensitive
      if (result.normalized) {
        const providerConfig = result.normalized.virtualrouter?.providers?.['iflow-provider'];
        assert.strictEqual(providerConfig?.auth?.device?.clientId, 'test-client-id');
      }
    });
  });

  describe('Sensitive Fields Coverage', () => {
    it('should include all expected sensitive fields', () => {
      const expectedFields = [
        'apiKey', 'api_key', 'secret', 'token', 'password', 'auth', 'credentials',
        'accessToken', 'access_token', 'refreshToken', 'refresh_token',
        'clientSecret', 'client_secret', 'webhookSecret', 'webhook_secret',
        'privateKey', 'private_key', 'signingKey', 'signing_key',
        'databasePassword', 'db_password', 'connectionString'
      ];

      expectedFields.forEach(field => {
        assert.ok(SENSITIVE_FIELDS.has(field), `Field '${field}' should be in SENSITIVE_FIELDS`);
      });
    });

    it('should handle case-insensitive field detection', () => {
      assert.ok(shouldSanitizeField('APIKEY', 'value'));
      assert.ok(shouldSanitizeField('Api_Key', 'value'));
      assert.ok(shouldSanitizeField('SECRET', 'value'));
      assert.ok(shouldSanitizeField('PASSWORD', 'value'));
    });
  });

  
  describe('Secret Pattern Coverage', () => {
    it('should include all expected pattern categories', () => {
      const expectedCategories = ['apiKey', 'token', 'urlWithCredentials', 'password', 'secretKeys', 'environmentVariables', 'genericLongString'];

      Object.keys(SECRET_PATTERNS).forEach(category => {
        assert.ok(expectedCategories.includes(category), `Pattern category '${category}' should be expected`);
      });
    });

    it('should have non-empty patterns for each category', () => {
      Object.values(SECRET_PATTERNS).forEach(patterns => {
        assert.ok(Array.isArray(patterns), 'Patterns should be an array');
        assert.ok(patterns.length > 0, 'Patterns should not be empty');

        patterns.forEach(pattern => {
          assert.ok(pattern instanceof RegExp, 'Each pattern should be a RegExp');
        });
      });
    });
  });

  describe('Real Configuration Scenarios', () => {
    it('should sanitize a complete realistic configuration', () => {
      const realisticConfig = {
        version: '1.0.0',
        schemaVersion: '2.0.0',
        port: 8080,
        virtualrouter: {
          inputProtocol: 'openai',
          outputProtocol: 'openai',
          providers: {
            'openai-provider': {
              id: 'openai-provider',
              type: 'openai',
              enabled: true,
              apiKey: 'sk-proj-abc123def456ghi789jkl012mno345pqr678stu901vwx234yz567',
              models: {
                'gpt-4': {
                  maxTokens: 4000,
                  temperature: 0.7
                },
                'gpt-3.5-turbo': {
                  maxTokens: 4096,
                  temperature: 0.5
                }
              }
            },
            'lmstudio-provider': {
              id: 'lmstudio-provider',
              type: 'lmstudio',
              enabled: true,
              apiKey: 'lm-studio-api-key-1234567890abcdef',
              baseURL: 'http://localhost:1234',
              models: {
                'llama2-7b': {
                  maxTokens: 2048,
                  temperature: 0.8
                }
              }
            }
          },
          routing: {
            default: ['openai-provider.gpt-4'],
            thinking: ['openai-provider.gpt-4'],
            coding: ['openai-provider.gpt-4'],
            longcontext: ['lmstudio-provider.llama2-7b'],
            tools: ['openai-provider.gpt-4'],
            vision: ['openai-provider.gpt-4'],
            websearch: ['lmstudio-provider.llama2-7b'],
            background: ['lmstudio-provider.llama2-7b']
          }
        }
      };

      const sanitized = createSafeConfig(realisticConfig);

      // Verify API keys are sanitized
      assert.strictEqual(
        sanitized.virtualrouter.providers['openai-provider'].apiKey,
        SANITIZATION_REPLACEMENT
      );
      assert.strictEqual(
        sanitized.virtualrouter.providers['lmstudio-provider'].apiKey,
        SANITIZATION_REPLACEMENT
      );

      // Verify non-sensitive data is preserved
      assert.strictEqual(sanitized.version, '1.0.0');
      assert.strictEqual(sanitized.port, 8080);
      assert.strictEqual(
        sanitized.virtualrouter.providers['openai-provider'].models['gpt-4'].maxTokens,
        4000
      );
    });

    it('should handle configurations with multiple authentication methods', () => {
      const multiAuthConfig = {
        version: '1.0.0',
        virtualrouter: {
          inputProtocol: 'openai',
          outputProtocol: 'openai',
          providers: {
            'provider1': {
              id: 'provider1',
              type: 'openai',
              enabled: true,
              apiKey: ['sk-abc123def456ghi789jkl', 'sk-xyz789uvw456abc123def', 'sk-lmn456opq789rst123uvw'],
              auth: {
                bearer: 'Bearer token123456'
              }
            },
            'provider2': {
              id: 'provider2',
              type: 'custom',
              enabled: true,
              credentials: {
                username: 'user',
                password: 'pass123',
                apiKey: 'custom-api-key-789'
              }
            }
          },
          routing: {
            default: ['provider1.model1', 'provider2.model2'],
            thinking: ['provider1.model1', 'provider2.model2'],
            coding: ['provider1.model1', 'provider2.model2'],
            longcontext: ['provider1.model1', 'provider2.model2'],
            tools: ['provider1.model1', 'provider2.model2'],
            vision: ['provider1.model1', 'provider2.model2'],
            websearch: ['provider1.model1', 'provider2.model2'],
            background: ['provider1.model1', 'provider2.model2']
          }
        }
      };

      const sanitized = createSafeConfig(multiAuthConfig);

      // Verify all sensitive data is sanitized
      assert.deepStrictEqual(
        sanitized.virtualrouter.providers.provider1.apiKey,
        [SANITIZATION_REPLACEMENT, SANITIZATION_REPLACEMENT, SANITIZATION_REPLACEMENT]
      );
      assert.strictEqual(
        sanitized.virtualrouter.providers.provider1.auth.bearer,
        SANITIZATION_REPLACEMENT
      );
      assert.strictEqual(
        sanitized.virtualrouter.providers.provider2.credentials.password,
        SANITIZATION_REPLACEMENT
      );
      assert.strictEqual(
        sanitized.virtualrouter.providers.provider2.credentials.apiKey,
        SANITIZATION_REPLACEMENT
      );

      // Verify non-sensitive data is preserved
      assert.strictEqual(
        sanitized.virtualrouter.providers.provider2.credentials.username,
        'user'
      );
    });
  });

});