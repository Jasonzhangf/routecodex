import { bootstrapVirtualRouterConfig } from './helpers/virtual-router-bootstrap-direct-native.js';

describe('bootstrapVirtualRouterConfig removed compat defaults', () => {
  it('keeps anthropic providers on passthrough without injected compat headers', () => {
    const input = {
      providers: {
        anthropic_test: {
          id: 'anthropic_test',
          enabled: true,
          type: 'anthropic',
          baseURL: 'https://anthropic.example.test',
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
            targets: ['anthropic_test.glm-4.7']
          }
        ]
      }
    } as any;

    const result = bootstrapVirtualRouterConfig(input);

    const runtime = result.runtime?.['anthropic_test.key1'] as any;
    expect(runtime?.compatibilityProfile).toBe('compat:passthrough');
    expect(runtime?.headers?.['User-Agent']).toBeUndefined();
    expect(runtime?.headers?.['X-App']).toBeUndefined();
    expect(runtime?.headers?.['X-App-Version']).toBeUndefined();
    expect(runtime?.headers?.['anthropic-beta']).toBeUndefined();
  });
});
