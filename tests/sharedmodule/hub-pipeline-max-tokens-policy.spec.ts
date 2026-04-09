import { describe, expect, test } from '@jest/globals';

import { applyMaxTokensPolicyForRequest } from '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-max-tokens-policy.js';
import { bootstrapVirtualRouterConfig } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/bootstrap.js';
import { VirtualRouterEngine } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine.js';

describe('hub pipeline max tokens policy', () => {
  test('clamps qwen request max tokens before provider request build', () => {
    const bootstrapped = bootstrapVirtualRouterConfig({
      virtualrouter: {
        providers: {
          qwen: {
            type: 'qwen',
            endpoint: 'https://example.invalid/v1/chat/completions',
            auth: {
              type: 'oauth',
              oauthProviderId: 'qwen'
            },
            models: {
              'qwen3.6-plus': {}
            }
          }
        },
        routing: {
          default: ['qwen.qwen3.6-plus']
        }
      }
    } as const);
    const routerEngine = new VirtualRouterEngine();
    routerEngine.initialize(bootstrapped.config);

    const request = {
      parameters: {
        max_tokens: 128000,
        max_output_tokens: 128000
      }
    } as any;

    applyMaxTokensPolicyForRequest(
      request,
      bootstrapped.providers['qwen.1.qwen3.6-plus'],
      routerEngine
    );

    expect(request.parameters.max_tokens).toBe(65536);
    expect(request.parameters.max_output_tokens).toBe(65536);
  });
});
