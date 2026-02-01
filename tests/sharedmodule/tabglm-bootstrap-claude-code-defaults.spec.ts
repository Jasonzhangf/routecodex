import { bootstrapVirtualRouterConfig } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/bootstrap.js';

describe('bootstrapVirtualRouterConfig tabglm defaults', () => {
  it('does not infer anthropic:claude-code without explicit compatibilityProfile', () => {
    const input = {
      providers: {
        tabglm: {
          id: 'tabglm',
          enabled: true,
          type: 'anthropic',
          baseURL: 'https://api.tabcode.cc/claude/glm',
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
  });

  it('injects Claude Code User-Agent only when compatibilityProfile is explicitly set', () => {
    const input = {
      providers: {
        tabglm: {
          id: 'tabglm',
          enabled: true,
          type: 'anthropic',
          baseURL: 'https://api.tabcode.cc/claude/glm',
          compatibilityProfile: 'anthropic:claude-code',
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
    expect(runtime?.compatibilityProfile).toBe('anthropic:claude-code');
    expect(String(runtime?.headers?.['User-Agent'] ?? '')).toContain('claude-cli/');
    expect(String(runtime?.headers?.['X-App'] ?? '')).toBe('claude-cli');
    expect(String(runtime?.headers?.['X-App-Version'] ?? '')).toMatch(/^\d+\.\d+\.\d+$/);
    expect(String(runtime?.headers?.['anthropic-beta'] ?? '')).toBeTruthy();
  });
});
