import { describe, expect, test } from '@jest/globals';

import { applyMaxTokensPolicyForRequest } from '../../src/conversion/hub/pipeline/hub-pipeline-max-tokens-policy.js';
import { bootstrapVirtualRouterConfig } from '../../../../tests/sharedmodule/helpers/virtual-router-bootstrap-direct-native.js';
import { VirtualRouterEngine } from '../../src/native/router-hotpath/native-virtual-router-runtime.js';

function buildBootstrapInput(processMode?: 'chat' | 'passthrough') {
  return {
    virtualrouter: {
      providers: {
        tabglm: {
          type: 'anthropic',
          endpoint: 'https://example.invalid/v1/messages',
          auth: {
            type: 'apiKey',
            value: 'sk-test'
          },
          ...(processMode ? { process: processMode } : {}),
          models: {
            'glm-5': {}
          }
        }
      },
      routing: {
        default: ['tabglm.glm-5']
      }
    }
  } as const;
}

describe('virtual-router provider max output defaults', () => {
  const providerKey = 'tabglm.key1.glm-5';

  function buildRouterEngine(input: ReturnType<typeof buildBootstrapInput>) {
    const bootstrapped = bootstrapVirtualRouterConfig(input);
    const routerEngine = new VirtualRouterEngine();
    routerEngine.initialize(bootstrapped.config);
    return { bootstrapped, routerEngine };
  }

  test('bootstraps 8k provider default for non-passthrough providers', () => {
    const bootstrapped = bootstrapVirtualRouterConfig(buildBootstrapInput('chat'));
    expect(bootstrapped.providers[providerKey]?.maxOutputTokens).toBe(8192);
  });

  test('does not bootstrap 8k provider default for passthrough providers', () => {
    const bootstrapped = bootstrapVirtualRouterConfig(buildBootstrapInput('passthrough'));
    expect(bootstrapped.providers[providerKey]?.maxOutputTokens).toBeUndefined();
  });

  test('request max_tokens overrides provider default instead of being capped by it', () => {
    const { bootstrapped, routerEngine } = buildRouterEngine(buildBootstrapInput('chat'));
    const target = bootstrapped.providers[providerKey];

    const requestWithDefault = { parameters: {} } as any;
    applyMaxTokensPolicyForRequest(requestWithDefault, target, routerEngine);
    expect(requestWithDefault.parameters.max_tokens).toBe(8192);

    const requestWithOverride = { parameters: { max_tokens: 16384 } } as any;
    applyMaxTokensPolicyForRequest(requestWithOverride, target, routerEngine);
    expect(requestWithOverride.parameters.max_tokens).toBe(16384);
  });

  test('provider targets are clamped by hard output cap at request normalization time', () => {
    const { bootstrapped, routerEngine } = buildRouterEngine({
      virtualrouter: {
        providers: {
          capped: {
            type: 'openai',
            endpoint: 'https://example.invalid/v1/chat/completions',
            auth: {
              type: 'apiKey',
              value: 'sk-test'
            },
            models: {
              'model-a': {}
            }
          }
        },
        routing: {
          default: ['capped.model-a']
        }
      }
    } as const);
    const cappedTarget = bootstrapped.providers['capped.1.model-a'];

    const oversized = {
      parameters: {
        max_tokens: 128000,
        max_output_tokens: 128000
      }
    } as any;
    applyMaxTokensPolicyForRequest(oversized, cappedTarget, routerEngine);

    expect(oversized.parameters.max_tokens).toBe(65536);
    expect(oversized.parameters.max_output_tokens).toBe(65536);
  });
});
