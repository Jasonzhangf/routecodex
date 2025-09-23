/**
 * User Configuration Parser Tests
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { UserConfigParser } from '../../src/config/user-config-parser.js';

describe('UserConfigParser', () => {
  let parser: UserConfigParser;

  beforeEach(() => {
    parser = new UserConfigParser();
  });

  describe('parseRouteTargets', () => {
    it('should parse route targets correctly', () => {
      const routingConfig = {
        default: [
          'openai.gpt-4.sk-xxx',
          'anthropic.claude-3-sonnet.sk-ant-xxx'
        ]
      };

      const result = parser['parseRouteTargets'](routingConfig);

      expect(result).toEqual({
        default: [
          {
            providerId: 'openai',
            modelId: 'gpt-4',
            keyId: 'sk-xxx',
            actualKey: 'sk-xxx',
            inputProtocol: 'openai',
            outputProtocol: 'openai'
          },
          {
            providerId: 'anthropic',
            modelId: 'claude-3-sonnet',
            keyId: 'sk-ant-xxx',
            actualKey: 'sk-ant-xxx',
            inputProtocol: 'openai',
            outputProtocol: 'openai'
          }
        ]
      });
    });
  });

  describe('parsePipelineConfigs', () => {
    it('should parse pipeline configs correctly', () => {
      const virtualRouterConfig = {
        providers: {
          openai: {
            type: 'openai',
            baseURL: 'https://api.openai.com/v1',
            apiKey: ['sk-xxx'],
            models: {
              'gpt-4': {
                maxContext: 128000,
                maxTokens: 32000
              }
            }
          }
        },
        inputProtocol: 'openai',
        outputProtocol: 'openai'
      };

      const result = parser['parsePipelineConfigs'](virtualRouterConfig);

      expect(Object.keys(result)).toContain('openai.gpt-4.sk-xxx');
      expect(result['openai.gpt-4.sk-xxx']).toEqual({
        provider: {
          type: 'openai',
          baseURL: 'https://api.openai.com/v1'
        },
        model: {
          maxContext: 128000,
          maxTokens: 32000
        },
        keyConfig: {
          keyId: 'sk-xxx',
          actualKey: 'sk-xxx',
          keyType: 'apiKey'
        },
        protocols: {
          input: 'openai',
          output: 'openai'
        },
        compatibility: {
          type: 'field-mapping',
          config: {}
        },
        llmSwitch: {
          type: 'openai-passthrough',
          config: {}
        },
        workflow: {
          type: 'streaming-control',
          enabled: true,
          config: {}
        }
      });
    });
  });

  describe('auth mapping collisions', () => {
    it('keeps provider-specific auth mappings distinct when key names overlap', () => {
      const userConfig: any = {
        virtualrouter: {
          inputProtocol: 'openai',
          outputProtocol: 'openai',
          routing: {
            default: [
              'qwen.qwen3-coder-plus.key1',
              'iflow.iflow-pro.key1'
            ]
          },
          providers: {
            qwen: {
              type: 'qwen-provider',
              baseURL: 'https://chat.qwen.ai',
              apiKey: ['key1'],
              auth: {
                key1: '~/.qwen/token.json'
              },
              models: {
                'qwen3-coder-plus': {}
              }
            },
            iflow: {
              type: 'iflow-http',
              baseURL: 'https://api.iflow.cn/v1',
              apiKey: ['key1'],
              auth: {
                key1: '~/.iflow/token.json'
              },
              models: {
                'iflow-pro': {}
              }
            }
          }
        }
      };

      const result = parser.parseUserConfig(userConfig);
      const [qwenTarget, iflowTarget] = result.routeTargets.default;

      expect(qwenTarget.actualKey).toBe('auth-key1');
      expect(iflowTarget.actualKey).toBe('auth-key1-1');
      expect(result.authMappings['auth-key1']).toBe('~/.qwen/token.json');
      expect(result.authMappings['auth-key1-1']).toBe('~/.iflow/token.json');
    });
  });
});
