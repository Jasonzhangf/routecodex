import { bootstrapVirtualRouterConfig } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/bootstrap.js';

function buildInput(extraVirtualRouter: Record<string, unknown> = {}) {
  return {
    virtualrouter: {
      providers: {
        glm: {
          type: 'openai',
          endpoint: 'https://example.invalid/v1/chat/completions',
          auth: { type: 'apiKey', value: 'test-key' },
          models: {
            'kimi-k2': {}
          }
        }
      },
      routing: {
        default: ['glm.kimi-k2']
      },
      ...extraVirtualRouter
    }
  } as any;
}

describe('bootstrapVirtualRouterConfig native config meta', () => {
  it('defaults execCommandGuard.enabled=true when omitted', () => {
    const result = bootstrapVirtualRouterConfig(buildInput());
    expect(result.config.execCommandGuard).toEqual({ enabled: true });
  });

  it('honors explicit false for execCommandGuard', () => {
    const result = bootstrapVirtualRouterConfig(buildInput({
      execCommandGuard: { enabled: false }
    }));
    expect(result.config.execCommandGuard).toBeUndefined();
  });

  it('normalizes classifier/context/clock via native bootstrap meta', () => {
    const result = bootstrapVirtualRouterConfig(buildInput({
      classifier: {
        longContextThresholdTokens: 123456,
        thinkingKeywords: ['  alpha  ', '', 'beta'],
        codingKeywords: [],
        backgroundKeywords: [' gamma ']
      },
      contextRouting: {
        warn_ratio: '1.3',
        hard_limit: 'true'
      },
      clock: {
        enabled: 'true',
        tickMs: 1234,
        includeTimeTag: 1
      }
    }));

    expect(result.config.classifier.longContextThresholdTokens).toBe(123456);
    expect(result.config.classifier.thinkingKeywords).toEqual(['alpha', 'beta']);
    expect(result.config.classifier.codingKeywords?.length).toBeGreaterThan(0);
    expect(result.config.contextRouting).toEqual({
      warnRatio: 0.99,
      hardLimit: true
    });
    expect(result.config.clock).toEqual({
      enabled: true,
      tickMs: 1234,
      includeTimeTag: true
    });
  });
});
