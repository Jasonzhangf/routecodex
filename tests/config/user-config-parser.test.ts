/**
 * User Configuration Parser Tests
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { UserConfigParser } from '../../src/config/user-config-parser.js';

describe.skip('UserConfigParser', () => {
  let parser: UserConfigParser;

  beforeEach(() => {
    parser = new UserConfigParser();
  });

  describe('parseRouteTargets', () => {
    it('should parse route targets correctly', () => {
      const userConfig = {
        virtualrouter: {
          inputProtocol: 'openai',
          outputProtocol: 'openai',
          routing: {
            default: [
              'openai.gpt-4.sk-xxx',
              'anthropic.claude-3-sonnet.sk-ant-xxx'
            ]
          },
          providers: {
            openai: {
              type: 'openai',
              apiKey: ['sk-xxx'],
              models: {
                'gpt-4': {}
              }
            },
            anthropic: {
              type: 'anthropic',
              apiKey: ['sk-ant-xxx'],
              models: {
                'claude-3-sonnet': {}
              }
            }
          }
        }
      };

      const result = parser.parseUserConfig(userConfig);

      expect(result.routeTargets).toEqual({
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
      const userConfig = {
        virtualrouter: {
          inputProtocol: 'openai',
          outputProtocol: 'openai',
          routing: {
            default: ['openai.gpt-4.sk-xxx']
          },
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
          }
        }
      };

      const result = parser.parseUserConfig(userConfig);

      expect(Object.keys(result.pipelineConfigs)).toContain('openai.gpt-4.sk-xxx');
      expect(result.pipelineConfigs['openai.gpt-4.sk-xxx']).toEqual({
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

      // The first provider gets 'auth-key1', the second gets 'auth-key1-1' due to collision handling
      expect(qwenTarget.actualKey).toMatch(/^auth-key1(-1)?$/);
      expect(iflowTarget.actualKey).toMatch(/^auth-key1(-1)?$/);
      // Ensure they are different (collision handling worked)
      expect(qwenTarget.actualKey).not.toBe(iflowTarget.actualKey);

      // Verify auth mappings exist for both keys
      const authKeys = Object.keys(result.authMappings);
      expect(authKeys).toContain(qwenTarget.actualKey);
      expect(authKeys).toContain(iflowTarget.actualKey);

      // Verify the correct auth paths are mapped
      expect(result.authMappings[qwenTarget.actualKey]).toBe('~/.qwen/token.json');
      expect(result.authMappings[iflowTarget.actualKey]).toBe('~/.iflow/token.json');
    });
  });
});
