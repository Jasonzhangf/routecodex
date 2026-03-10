import { describe, expect, test } from '@jest/globals';

import { ContextAdvisor } from '../../src/router/virtual-router/context-advisor.js';
import { selectProviderImpl } from '../../src/router/virtual-router/engine/routing-pools/index.js';
import { ProviderHealthManager } from '../../src/router/virtual-router/health-manager.js';
import { RouteLoadBalancer } from '../../src/router/virtual-router/load-balancer.js';
import { ProviderRegistry } from '../../src/router/virtual-router/provider-registry.js';
import type {
  ClassificationResult,
  RoutePoolTier,
  RouterMetadataInput,
  RoutingFeatures
} from '../../src/router/virtual-router/types.js';
import type { RoutingInstructionState } from '../../src/router/virtual-router/routing-instructions.js';

function buildState(): RoutingInstructionState {
  return {
    allowedProviders: new Set(),
    disabledProviders: new Set(),
    disabledKeys: new Map(),
    disabledModels: new Map()
  };
}

function buildFeatures(metadata: RouterMetadataInput): RoutingFeatures {
  return {
    requestId: metadata.requestId,
    model: 'deepseek-chat',
    totalMessages: 1,
    userTextSample: 'hello',
    toolCount: 0,
    hasTools: false,
    hasToolCallResponses: false,
    hasVisionTool: false,
    hasImageAttachment: false,
    hasWebTool: false,
    hasWebSearchToolDeclared: false,
    hasCodingTool: false,
    hasThinkingKeyword: false,
    estimatedTokens: 64,
    latestMessageFromUser: true,
    metadata
  };
}

function buildClassification(routeName: string): ClassificationResult {
  return {
    routeName,
    confidence: 1,
    reasoning: routeName,
    fallback: false,
    candidates: [routeName]
  };
}

describe('virtual-router provider unavailable cooldown hint', () => {
  test('exposes minRecoverableCooldownMs for quota cooldown exhaustion', () => {
    const providerKey = 'deepseek-web.1.deepseek-chat';
    const providerRegistry = new ProviderRegistry({
      [providerKey]: {
        providerKey,
        providerType: 'openai',
        endpoint: 'https://example.invalid',
        auth: { type: 'apiKey', value: 'x' },
        outboundProfile: 'openai-chat',
        modelId: 'deepseek-chat'
      } as any
    });

    const routing: Record<string, RoutePoolTier[]> = {
      default: [
        {
          id: 'default-primary',
          priority: 100,
          mode: 'priority',
          targets: [providerKey]
        }
      ]
    };

    const healthManager = new ProviderHealthManager();
    healthManager.registerProviders(providerRegistry.listKeys());

    const now = Date.now();
    const cooldownUntil = now + 1500;

    try {
      selectProviderImpl(
        'default',
        { requestId: 'req-cooldown-hint' },
        buildClassification('default'),
        buildFeatures({ requestId: 'req-cooldown-hint' }),
        buildState(),
        {
          routing,
          providerRegistry,
          healthManager,
          contextAdvisor: new ContextAdvisor(),
          loadBalancer: new RouteLoadBalancer({ strategy: 'round-robin' }),
          isProviderCoolingDown: () => false,
          getProviderCooldownRemainingMs: () => 0,
          resolveStickyKey: () => undefined,
          quotaView: () => ({
            inPool: false,
            cooldownUntil,
            blacklistUntil: null
          } as any)
        }
      );
      throw new Error('expected selectProviderImpl to throw');
    } catch (error) {
      const err = error as any;
      expect(err?.code).toBe('PROVIDER_NOT_AVAILABLE');
      expect(typeof err?.details?.minRecoverableCooldownMs).toBe('number');
      expect(err.details.minRecoverableCooldownMs).toBeGreaterThan(0);
      expect(err.details.minRecoverableCooldownMs).toBeLessThanOrEqual(1500);
      expect(Array.isArray(err?.details?.recoverableCooldownHints)).toBe(true);
      expect(err.details.recoverableCooldownHints[0]).toMatchObject({
        providerKey,
        source: 'quota.cooldown'
      });
    }
  });
});
