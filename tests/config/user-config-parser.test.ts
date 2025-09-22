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
          actualKey: 'sk-xxx'
        },
        protocols: {
          input: 'openai',
          output: 'openai'
        }
      });
    });
  });
});
