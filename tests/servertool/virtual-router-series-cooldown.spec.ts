import { RateLimitBackoffManager, RateLimitCooldownError } from '../../src/providers/core/runtime/rate-limit-manager.js';
import { VirtualRouterEngine } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine.js';
import { deserializeRoutingInstructionState } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/routing-instructions.js';
import { saveRoutingInstructionStateSync } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/sticky-session-store.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  VirtualRouterConfig,
  ProviderErrorEvent,
  RouterMetadataInput
} from '../../sharedmodule/llmswitch-core/src/router/virtual-router/types.js';
import type { StandardizedRequest } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/standardized.js';

describe('Virtual router series cooldown', () => {
  it('blacklists an entire model series after repeated 429s', () => {
    const manager = new RateLimitBackoffManager([10, 20], 50);
    const bucket = 'gemini.alias2.gemini-3-pro-high';
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
  const providerA = 'gemini.alias1.gemini-3-pro-high';
  const providerB = 'gemini.alias2.gemini-3-pro-high';

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
          providerId: 'gemini.alias1',
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
          providerId: 'gemini.alias1',
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

describe('Virtual router sticky fallback with excluded keys', () => {
  const providerA = 'gemini.alias1.gemini-3-pro-high';
  const providerB = 'gemini.alias2.gemini-3-pro-high';
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
        provider: 'gemini',
        keyAlias: 'alias1',
        pathLength: 3
      }
    });
    const sessionKey = 'session:sticky-session';
    const prevSessionDir = process.env.ROUTECODEX_SESSION_DIR;
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-session-'));
    process.env.ROUTECODEX_SESSION_DIR = sessionDir;
    try {
      saveRoutingInstructionStateSync(sessionKey, stickyState);

      const first = engine.route(baseRequest, { ...baseMetadata });
      expect(first.target.providerKey).toBe(providerA);

      const second = engine.route(baseRequest, {
        ...baseMetadata,
        excludedProviderKeys: [providerA]
      });
      expect(second.target.providerKey).toBe(providerB);
    } finally {
      if (prevSessionDir === undefined) {
        delete process.env.ROUTECODEX_SESSION_DIR;
      } else {
        process.env.ROUTECODEX_SESSION_DIR = prevSessionDir;
      }
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });
});
