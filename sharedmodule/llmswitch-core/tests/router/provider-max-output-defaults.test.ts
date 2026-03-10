import { describe, expect, test } from '@jest/globals';

import { HubPipeline } from '../../src/conversion/hub/pipeline/hub-pipeline.js';
import { bootstrapVirtualRouterConfig } from '../../src/router/virtual-router/bootstrap.js';

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

  test('bootstraps 8k provider default for non-passthrough providers', () => {
    const bootstrapped = bootstrapVirtualRouterConfig(buildBootstrapInput('chat'));
    expect(bootstrapped.providers[providerKey]?.maxOutputTokens).toBe(8192);
  });

  test('does not bootstrap 8k provider default for passthrough providers', () => {
    const bootstrapped = bootstrapVirtualRouterConfig(buildBootstrapInput('passthrough'));
    expect(bootstrapped.providers[providerKey]?.maxOutputTokens).toBeUndefined();
  });

  test('request max_tokens overrides provider default instead of being capped by it', () => {
    const bootstrapped = bootstrapVirtualRouterConfig(buildBootstrapInput('chat'));
    const target = bootstrapped.providers[providerKey];
    const pipeline = new HubPipeline({
      virtualRouter: bootstrapped.config
    });

    const requestWithDefault = { parameters: {} } as any;
    (pipeline as any).applyMaxTokensPolicy(requestWithDefault, target);
    expect(requestWithDefault.parameters.max_tokens).toBe(8192);

    const requestWithOverride = { parameters: { max_tokens: 16384 } } as any;
    (pipeline as any).applyMaxTokensPolicy(requestWithOverride, target);
    expect(requestWithOverride.parameters.max_tokens).toBe(16384);
  });
});
