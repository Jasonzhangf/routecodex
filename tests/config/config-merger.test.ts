/**
 * Configuration Merger Tests
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { ConfigMerger } from '../../src/config/config-merger.js';

describe('ConfigMerger', () => {
  let merger: ConfigMerger;

  beforeEach(() => {
    merger = new ConfigMerger();
  });

  describe('mergeConfigs', () => {
    it('should merge system and user configs correctly', () => {
      const systemConfig = {
        modules: {
          httpserver: {
            enabled: true,
            config: {
              moduleType: 'http-server',
              port: 5506,
              host: 'localhost'
            }
          },
          virtualrouter: {
            enabled: true,
            config: {
              moduleType: 'virtual-router',
              timeout: 30000
            }
          }
        }
      };

      const userConfig = {
        virtualrouter: {
          inputProtocol: 'openai',
          outputProtocol: 'openai'
        }
      };

      const parsedUserConfig = {
        routeTargets: {
          default: []
        },
        pipelineConfigs: {},
        moduleConfigs: {
          httpserver: {
            enabled: true,
            config: {
              port: 8080
            }
          }
        }
      };

      const result = merger.mergeConfigs(systemConfig, userConfig, parsedUserConfig);

      expect(result.modules.httpserver.config.port).toBe(8080);
      expect(result.modules.httpserver.config.host).toBe('localhost');
      expect(result.modules.virtualrouter.config.routeTargets).toBeDefined();
    });
  });

  describe('deepMerge', () => {
    it('should merge objects deeply', () => {
      const target = {
        a: 1,
        b: {
          c: 2,
          d: 3
        }
      };

      const source = {
        b: {
          c: 4,
          e: 5
        },
        f: 6
      };

      const result = merger['deepMerge'](target, source);

      expect(result).toEqual({
        a: 1,
        b: {
          c: 4,
          d: 3,
          e: 5
        },
        f: 6
      });
    });
  });
});
