import { bootstrapVirtualRouterConfig } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-bootstrap-config.js';

describe('bootstrapVirtualRouterConfig removed compat defaults', () => {
  it('keeps anthropic providers on passthrough without injected compat headers', () => {
    const input = {
      providers: {
        tabglm: {
          id: 'tabglm',
          enabled: true,
          type: 'anthropic',
          baseURL: 'https://api.tabcode.cc/claude/glm',
          compatibilityProfile: 'compat:passthrough',
          auth: {
            type: 'apikey',
            apiKey: 'test'
          },
          models: {
            'glm-4.7': { supportsStreaming: true }
          }
        }
      },
      routing: {
        default: [
          {
            id: 'default-primary',
            mode: 'priority',
            targets: ['tabglm.glm-4.7']
          }
        ]
      }
    } as any;

    const result = bootstrapVirtualRouterConfig(input);

    const runtime = result.runtime?.['tabglm.key1'] as any;
    expect(runtime?.compatibilityProfile).toBe('compat:passthrough');
    expect(runtime?.headers?.['User-Agent']).toBeUndefined();
    expect(runtime?.headers?.['X-App']).toBeUndefined();
    expect(runtime?.headers?.['X-App-Version']).toBeUndefined();
    expect(runtime?.headers?.['anthropic-beta']).toBeUndefined();
  });
});
