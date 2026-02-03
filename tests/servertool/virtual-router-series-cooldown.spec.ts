import { RateLimitBackoffManager, RateLimitCooldownError } from '../../src/providers/core/runtime/rate-limit-manager.js';
import { VirtualRouterEngine } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine.js';
import { deserializeRoutingInstructionState } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/routing-instructions.js';
import {
  cacheAntigravitySessionSignature,
  extractAntigravityGeminiSessionId
} from '../../sharedmodule/llmswitch-core/src/conversion/compat/antigravity-session-signature.js';
import type {
  VirtualRouterConfig,
  ProviderErrorEvent,
  RouterMetadataInput
} from '../../sharedmodule/llmswitch-core/src/router/virtual-router/types.js';
import type { StandardizedRequest } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/standardized.js';

describe('Virtual router series cooldown', () => {
  it('blacklists an entire model series after repeated 429s', () => {
    const manager = new RateLimitBackoffManager([10, 20], 50);
    const bucket = 'antigravity.2-jasonqueque.gemini-3-pro-high';
    const model = 'gemini-3-pro-high';

    const first = manager.record429(bucket, model);
    expect(first.seriesBlacklisted).toBe(false);

    const second = manager.record429(bucket, model);
    expect(second.seriesBlacklisted).toBe(true);

    const error = manager.buildThrottleError({ providerKey: bucket, model });
    expect(error).toBeInstanceOf(RateLimitCooldownError);
    expect(error?.message).toContain('series');
  });
});

describe('VirtualRouterEngine series cooldown handling', () => {
  const providerA = 'antigravity.alias1.gemini-3-pro-high';
  const providerB = 'antigravity.alias2.gemini-3-pro-high';

  const baseConfig: VirtualRouterConfig = {
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

  it('blacklists only the alias that triggered 429', () => {
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
      details: {
        virtualRouterSeriesCooldown: {
          providerId: 'antigravity.alias1',
          providerKey: providerA,
          model: 'gemini-3-pro-high',
          series: 'gemini-pro',
          cooldownMs: 60_000
        }
      }
    };

    engine.handleProviderError(event);

    const status = engine.getStatus().health;
    expect(status.find((entry) => entry.providerKey === providerA)?.state).toBe('tripped');
    expect(status.find((entry) => entry.providerKey === providerB)?.state).not.toBe('tripped');
  });

  it('does not produce router-local cooldowns when quotaView is enabled', () => {
    const quotaView = (key: string) => ({
      providerKey: key,
      inPool: true,
      reason: 'ok',
      priorityTier: 100,
      cooldownUntil: null,
      blacklistUntil: null
    });
    const engine = new VirtualRouterEngine({ quotaView } as any);
    engine.initialize(baseConfig);

    const event: ProviderErrorEvent = {
      code: 'HTTP_429',
      message: 'Rate limit',
      stage: 'provider.http',
      runtime: {
        requestId: 'req_test_quota',
        providerKey: providerA
      },
      timestamp: Date.now(),
      details: {
        virtualRouterSeriesCooldown: {
          providerId: 'antigravity.alias1',
          providerKey: providerA,
          model: 'gemini-3-pro-high',
          series: 'gemini-pro',
          cooldownMs: 60_000
        }
      }
    };

    engine.handleProviderError(event);

    const status = engine.getStatus().health;
    expect(status.find((entry) => entry.providerKey === providerA)?.state).not.toBe('tripped');
    expect(status.find((entry) => entry.providerKey === providerB)?.state).not.toBe('tripped');
  });
});

describe('Virtual router antigravity strict session alias binding', () => {
  it('does not rotate to another alias for the same session', () => {
    const ag1 = 'antigravity.alias1.gemini-3-pro-high';
    const ag2 = 'antigravity.alias2.gemini-3-pro-high';
    const fallback = 'tab.key1.gpt-5.2';

    const engine = new VirtualRouterEngine();
    engine.initialize({
      routing: {
        default: [
          {
            id: 'primary',
            mode: 'priority',
            targets: [ag1, ag2, fallback],
            priority: 1
          }
        ]
      },
      providers: {
        [ag1]: {
          providerKey: ag1,
          providerType: 'gemini',
          endpoint: 'https://example.invalid',
          auth: { type: 'apiKey', value: 'test' },
          outboundProfile: 'gemini-chat',
          runtimeKey: 'runtime:ag1',
          modelId: 'gemini-3-pro-high'
        },
        [ag2]: {
          providerKey: ag2,
          providerType: 'gemini',
          endpoint: 'https://example.invalid',
          auth: { type: 'apiKey', value: 'test' },
          outboundProfile: 'gemini-chat',
          runtimeKey: 'runtime:ag2',
          modelId: 'gemini-3-pro-high'
        },
        [fallback]: {
          providerKey: fallback,
          providerType: 'responses',
          endpoint: 'https://example.invalid',
          auth: { type: 'apiKey', value: 'test' },
          outboundProfile: 'openai-responses',
          runtimeKey: 'runtime:tab',
          modelId: 'gpt-5.2'
        }
      },
      loadBalancing: {
        strategy: 'round-robin',
        aliasSelection: { antigravitySessionBinding: 'strict' }
      },
      classifier: {},
      health: { failureThreshold: 3, cooldownMs: 5_000, fatalCooldownMs: 60_000 }
    } as any);

    const request: StandardizedRequest = {
      model: 'client-model',
      messages: [{ role: 'user', content: 'hello' }],
      parameters: {},
      metadata: { originalEndpoint: '/v1/responses', processMode: 'chat' }
    };
    const metadata: RouterMetadataInput = {
      requestId: 'req_ag_strict_1',
      entryEndpoint: '/v1/responses',
      processMode: 'chat',
      stream: true,
      direction: 'request',
      sessionId: 'session-strict'
    };

    const first = engine.route(request, metadata);
    expect(first.target.providerKey).toBe(ag1);

    // Simulate a successful upstream response that returned thoughtSignature.
    // Strict binding should only activate after the session has a pinned signature.
    const sessionId = extractAntigravityGeminiSessionId({ contents: [{ role: 'user', parts: [{ text: 'hello' }] }] });
    cacheAntigravitySessionSignature('antigravity.alias1', sessionId, 'x'.repeat(60), 1);

    // Mark alias1 as unavailable; strict binding must not switch to alias2 for the same session.
    engine.handleProviderFailure({ providerKey: ag1, reason: 'auth', fatal: true, statusCode: 403 });

    const second = engine.route(request, { ...metadata, requestId: 'req_ag_strict_2' });
    expect(second.target.providerKey).toBe(fallback);
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

describe('Virtual router antigravity safer fallback on repeated errors', () => {
  const ag1 = 'antigravity.alias1.gemini-3-pro-high';
  const ag2 = 'antigravity.alias2.gemini-3-pro-high';
  const ag3 = 'antigravity.alias3.gemini-3-pro-high';
  const other = 'tabglm.key1.glm-4.7';

  const config: VirtualRouterConfig = {
    routing: {
      default: [
        {
          id: 'primary',
          targets: [ag1, ag2, ag3, other],
          priority: 1
        }
      ]
    },
    providers: {
      [ag1]: {
        providerKey: ag1,
        providerType: 'gemini',
        endpoint: 'https://example.invalid',
        auth: { type: 'apiKey', value: 'test' },
        outboundProfile: 'gemini-chat',
        runtimeKey: 'runtime:ag1',
        modelId: 'gemini-3-pro-high'
      },
      [ag2]: {
        providerKey: ag2,
        providerType: 'gemini',
        endpoint: 'https://example.invalid',
        auth: { type: 'apiKey', value: 'test' },
        outboundProfile: 'gemini-chat',
        runtimeKey: 'runtime:ag2',
        modelId: 'gemini-3-pro-high'
      },
      [ag3]: {
        providerKey: ag3,
        providerType: 'gemini',
        endpoint: 'https://example.invalid',
        auth: { type: 'apiKey', value: 'test' },
        outboundProfile: 'gemini-chat',
        runtimeKey: 'runtime:ag3',
        modelId: 'gemini-3-pro-high'
      },
      [other]: {
        providerKey: other,
        providerType: 'anthropic',
        endpoint: 'https://example.invalid',
        auth: { type: 'apiKey', value: 'test' },
        outboundProfile: 'anthropic-messages',
        runtimeKey: 'runtime:other',
        modelId: 'glm-4.7'
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

  it('prefers non-antigravity targets after two consecutive identical antigravity errors (unless none)', () => {
    const engine = new VirtualRouterEngine();
    engine.initialize(config);

    const routed = engine.route(baseRequest, {
      requestId: 'req_ag_safe',
      entryEndpoint: '/v1/responses',
      processMode: 'chat',
      stream: true,
      direction: 'request',
      excludedProviderKeys: [ag1, ag2],
      __rt: {
        antigravityRetryErrorSignature: '403:HTTP_403',
        antigravityRetryErrorConsecutive: 2
      }
    } as any);

    expect(routed.target.providerKey).toBe(other);
  });
});
