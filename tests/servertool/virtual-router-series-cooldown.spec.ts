import { RateLimitBackoffManager, RateLimitCooldownError } from '../../src/providers/core/runtime/rate-limit-manager.js';
import { VirtualRouterEngine } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine.js';
import { deserializeRoutingInstructionState } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/routing-instructions.js';
import type {
  VirtualRouterConfig,
  ProviderErrorEvent,
  RouterMetadataInput
} from '../../sharedmodule/llmswitch-core/src/router/virtual-router/types.js';
import type { StandardizedRequest } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/standardized.js';

describe('Virtual router series cooldown', () => {
  it('applies provider cooldown after repeated 429s', () => {
    const manager = new RateLimitBackoffManager([10, 20], 50);
    const bucket = 'antigravity.2-jasonqueque.gemini-3-pro-high';
    const model = 'gemini-3-pro-high';

    const first = manager.record429(bucket, model);
    expect(first.consecutive).toBe(1);

    const second = manager.record429(bucket, model);
    expect(second.consecutive).toBe(2);

    const error = manager.buildThrottleError({ providerKey: bucket, model });
    expect(error).toBeInstanceOf(RateLimitCooldownError);
    expect(error?.message).toContain('cooling down');
  });
});

describe('VirtualRouterEngine series cooldown handling', () => {
  const providerA = 'antigravity.alias1.gemini-3-pro-high';
  const providerA2 = 'antigravity.alias1.gemini-3-pro-low';
  const providerB = 'antigravity.alias2.gemini-3-pro-high';

  const baseConfig: VirtualRouterConfig = {
    routing: {
      default: [
        {
          id: 'primary',
          targets: [providerA, providerA2, providerB],
          priority: 1
        }
      ]
    },
    providers: {
      [providerA]: {
        providerKey: providerA,
        providerType: 'gemini',
        endpoint: 'https://example.invalid',
        auth: { type: 'apiKey', value: 'test' },
        outboundProfile: 'gemini-chat',
        runtimeKey: 'runtime:a',
        modelId: 'gemini-3-pro-high'
      },
      [providerA2]: {
        providerKey: providerA2,
        providerType: 'gemini',
        endpoint: 'https://example.invalid',
        auth: { type: 'apiKey', value: 'test' },
        outboundProfile: 'gemini-chat',
        runtimeKey: 'runtime:a2',
        modelId: 'gemini-3-pro-low'
      },
      [providerB]: {
        providerKey: providerB,
        providerType: 'gemini',
        endpoint: 'https://example.invalid',
        auth: { type: 'apiKey', value: 'test' },
        outboundProfile: 'gemini-chat',
        runtimeKey: 'runtime:b',
        modelId: 'gemini-3-pro-high'
      }
    },
    classifier: {}
  };

  it('does not propagate cooldown to sibling aliases when details are absent', () => {
    const engine = new VirtualRouterEngine();
    engine.initialize(baseConfig);
    const event: ProviderErrorEvent = {
      code: 'HTTP_429',
      message: 'Rate limit',
      stage: 'provider.http',
      runtime: {
        requestId: 'req_test',
        providerKey: providerA
      },
      timestamp: Date.now(),
      details: {}
    };

    engine.handleProviderError(event);

    const status = engine.getStatus().health;
    expect(status.find((entry) => entry.providerKey === providerA)?.state).toBe('tripped');
    expect(status.find((entry) => entry.providerKey === providerA2)?.state).toBe('healthy');
    expect(status.find((entry) => entry.providerKey === providerB)?.state).not.toBe('tripped');
  });

  it('keeps all aliases healthy with quotaView when details are absent', () => {
    const quotaView = (providerKey: string) => ({ providerKey, inPool: true });
    const engine = new VirtualRouterEngine({ quotaView });
    engine.initialize(baseConfig);
    const event: ProviderErrorEvent = {
      code: 'HTTP_429',
      message: 'Rate limit',
      stage: 'provider.http',
      runtime: {
        requestId: 'req_test',
        providerKey: providerA
      },
      timestamp: Date.now(),
      details: {}
    };

    engine.handleProviderError(event);

    const status = engine.getStatus().health;
    expect(status.find((entry) => entry.providerKey === providerA)?.state).toBe('healthy');
    expect(status.find((entry) => entry.providerKey === providerA2)?.state).toBe('healthy');
    expect(status.find((entry) => entry.providerKey === providerB)?.state).not.toBe('tripped');
  });
});

describe('Virtual router sticky fallback with excluded keys', () => {
  const providerA = 'antigravity.alias1.gemini-3-pro-high';
  const providerB = 'antigravity.alias2.gemini-3-pro-high';
  const config: VirtualRouterConfig = {
    routing: {
      default: [
        {
          id: 'primary',
          targets: [providerA, providerB],
          priority: 1
        }
      ]
    },
    providers: {
      [providerA]: {
        providerKey: providerA,
        providerType: 'gemini',
        endpoint: 'https://example.invalid',
        auth: { type: 'apiKey', value: 'test' },
        outboundProfile: 'gemini-chat',
        runtimeKey: 'runtime:a',
        modelId: 'gemini-3-pro-high'
      },
      [providerB]: {
        providerKey: providerB,
        providerType: 'gemini',
        endpoint: 'https://example.invalid',
        auth: { type: 'apiKey', value: 'test' },
        outboundProfile: 'gemini-chat',
        runtimeKey: 'runtime:b',
        modelId: 'gemini-3-pro-high'
      }
    },
    classifier: {}
  };

  const baseRequest: StandardizedRequest = {
    model: 'client-model',
    messages: [{ role: 'user', content: 'hello' }],
    parameters: {},
    metadata: { originalEndpoint: '/v1/responses', processMode: 'chat' }
  };

  const baseMetadata: RouterMetadataInput = {
    requestId: 'req_sticky',
    entryEndpoint: '/v1/responses',
    processMode: 'chat',
    stream: true,
    direction: 'request',
    sessionId: 'sticky-session'
  };

  it('skips sticky alias when excludedProviderKeys contains the runtime key', () => {
    const engine = new VirtualRouterEngine();
    engine.initialize(config);
    const stickyState = deserializeRoutingInstructionState({
      stickyTarget: {
        provider: 'antigravity',
        keyAlias: 'alias1',
        pathLength: 3
      }
    });
    (engine as any).routingInstructionState.set('session:sticky-session', stickyState);

    const first = engine.route(baseRequest, { ...baseMetadata });
    expect(first.target.providerKey).toBe(providerA);

    const second = engine.route(baseRequest, {
      ...baseMetadata,
      excludedProviderKeys: [providerA]
    });
    expect(second.target.providerKey).toBe(providerB);
  });
});
