/**
 * Virtual Router Module Tests
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { VirtualRouterModule } from '../../src/modules/virtual-router/virtual-router-module.js';

describe('VirtualRouterModule', () => {
  let module: VirtualRouterModule;

  beforeEach(() => {
    module = new VirtualRouterModule();
  });

  describe('initialize', () => {
    it('should initialize with valid config', async () => {
      const config = {
        routeTargets: {
          default: [
            {
              providerId: 'openai',
              modelId: 'gpt-4',
              keyId: 'sk-xxx',
              actualKey: 'sk-xxx',
              inputProtocol: 'openai',
              outputProtocol: 'openai'
            }
          ]
        },
        pipelineConfigs: {
          'openai.gpt-4.sk-xxx': {
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
          }
        },
        inputProtocol: 'openai',
        outputProtocol: 'openai',
        timeout: 30000
      };

      await expect(module.initialize(config)).resolves.not.toThrow();
    });
  });

  describe('routeRequest', () => {
    it('should route request to correct target', async () => {
      const config = {
        routeTargets: {
          default: [
            {
              providerId: 'openai',
              modelId: 'gpt-4',
              keyId: 'sk-xxx',
              actualKey: 'sk-xxx',
              inputProtocol: 'openai',
              outputProtocol: 'openai'
            }
          ]
        },
        pipelineConfigs: {
          'openai.gpt-4.sk-xxx': {
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
          }
        },
        inputProtocol: 'openai',
        outputProtocol: 'openai',
        timeout: 30000
      };

      await module.initialize(config);

      const request = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'Hello' }]
      };

      const response = await module.routeRequest(request, 'default');

      expect(response).toBeDefined();
      expect(response.object).toBe('chat.completion');
    });
  });
});
