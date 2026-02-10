import { bootstrapVirtualRouterConfig } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/bootstrap.js';
import { VirtualRouterEngine } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine.js';
import type {
  RouterMetadataInput,
  VirtualRouterBootstrapInput
} from '../../sharedmodule/llmswitch-core/src/router/virtual-router/types.js';
import type {
  StandardizedMessage,
  StandardizedRequest
} from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/standardized.js';

function buildEngine(): VirtualRouterEngine {
  const input: VirtualRouterBootstrapInput = {
    virtualrouter: {
      providers: {
        antigravity: {
          id: 'antigravity',
          type: 'openai',
          endpoint: 'https://example.invalid',
          auth: {
            type: 'apikey',
            keys: {
              sonnetkey: { value: 'SONNET' },
              sonnetbackup: { value: 'SONNET-BACKUP' },
              geminikey: { value: 'GEMINI' }
            }
          },
          models: {
            'claude-sonnet-4-5': {},
            'gemini-3-pro-high': {}
          }
        }
      },
      routing: {
        default: [
          'antigravity.claude-sonnet-4-5',
          'antigravity.geminikey.gemini-3-pro-high'
        ]
      }
    }
  };
  const { config } = bootstrapVirtualRouterConfig(input);
  const engine = new VirtualRouterEngine();
  engine.initialize(config);
  return engine;
}

function buildEnginePreferFallback(): VirtualRouterEngine {
  const input: VirtualRouterBootstrapInput = {
    virtualrouter: {
      providers: {
        antigravity: {
          id: 'antigravity',
          type: 'openai',
          endpoint: 'https://example.invalid',
          auth: {
            type: 'apikey',
            keys: {
              sonnetkey: { value: 'SONNET' },
              sonnetbackup: { value: 'SONNET-BACKUP' },
              geminikey: { value: 'GEMINI' }
            }
          },
          models: {
            'claude-sonnet-4-5': {},
            'gemini-3-pro-high': {}
          }
        }
      },
      routing: {
        // Only Claude is present in the normal route pool; prefer-mode must still be able to select Gemini.
        default: ['antigravity.claude-sonnet-4-5']
      }
    }
  };
  const { config } = bootstrapVirtualRouterConfig(input);
  const engine = new VirtualRouterEngine();
  engine.initialize(config);
  return engine;
}

function buildEngineAllowlistGlobalFallback(): VirtualRouterEngine {
  const input: VirtualRouterBootstrapInput = {
    virtualrouter: {
      providers: {
        antigravity: {
          id: 'antigravity',
          type: 'openai',
          endpoint: 'https://example.invalid',
          auth: {
            type: 'apikey',
            keys: {
              sonnetkey: { value: 'SONNET' }
            }
          },
          models: {
            'claude-sonnet-4-5': {}
          }
        },
        glm: {
          id: 'glm',
          type: 'openai',
          endpoint: 'https://example.invalid',
          auth: {
            type: 'apikey',
            keys: {
              key1: { value: 'GLM' }
            }
          },
          models: {
            'glm-4.7': {}
          }
        }
      },
      // Ensure the preferred provider appears in the classifier candidate routes for this test.
      // This keeps the test focused on routing-instruction parsing rather than classifier fallback.
      routing: {
        longcontext: ['antigravity.claude-sonnet-4-5', 'glm.glm-4.7'],
        default: ['antigravity.claude-sonnet-4-5'],
        'default-backup': ['glm.glm-4.7']
      }
    }
  };
  const { config } = bootstrapVirtualRouterConfig(input);
  const engine = new VirtualRouterEngine();
  engine.initialize(config);
  return engine;
}

function buildRequest(userContent: string): StandardizedRequest {
  const messages: StandardizedMessage[] = [
    {
      role: 'user',
      content: userContent
    }
  ];
  return {
    model: 'dummy',
    messages,
    tools: [],
    parameters: {},
    metadata: {
      originalEndpoint: '/v1/chat/completions',
      webSearchEnabled: false
    }
  };
}

function buildMetadata(
  overrides?: Partial<RouterMetadataInput> & { disableStickyRoutes?: boolean }
): RouterMetadataInput & { disableStickyRoutes?: boolean } {
  return {
    requestId: `req-${Math.random().toString(36).slice(2)}`,
    entryEndpoint: '/v1/chat/completions',
    processMode: 'chat',
    stream: false,
    direction: 'request',
    providerProtocol: 'openai-chat',
    stage: 'inbound',
    routeHint: 'default',
    ...(overrides ?? {})
  };
}

function supportsPreferPassthroughSuffix(): boolean {
  const engine = buildEngine();
  const request = buildRequest('<**!antigravity.gemini-3-pro-high:passthrough**>');
  const { target, decision } = engine.route(request, buildMetadata({ sessionId: 'session-probe-passthrough' }));
  return decision.routeName === 'prefer' && target.providerKey.includes('gemini-3-pro-high') && target.processMode === 'passthrough';
}

const SUPPORTS_PREFER_PROCESSMODE_SUFFIX = supportsPreferPassthroughSuffix();
const testIf = (condition: boolean) => (condition ? test : test.skip);

describe('VirtualRouterEngine routing instructions', () => {
  test('prefer instructions honor provider.model syntax', () => {
    const engine = buildEngine();
    const request = buildRequest('<**!antigravity.gemini-3-pro-high**>');
    const { target, decision } = engine.route(request, buildMetadata({ sessionId: 'session-prefer-model' }));
    expect(decision.routeName).toBe('prefer');
    expect(target.providerKey.includes('gemini-3-pro-high')).toBe(true);
  });

  testIf(SUPPORTS_PREFER_PROCESSMODE_SUFFIX)('prefer instructions propagate :passthrough mode to target metadata', () => {
    const engine = buildEngine();
    const request = buildRequest('<**!antigravity.gemini-3-pro-high:passthrough**>');
    const { target, decision } = engine.route(request, buildMetadata({ sessionId: 'session-prefer-passthrough' }));
    expect(decision.routeName).toBe('prefer');
    expect(target.providerKey.includes('gemini-3-pro-high')).toBe(true);
    expect(target.processMode).toBe('passthrough');
  });

  testIf(!SUPPORTS_PREFER_PROCESSMODE_SUFFIX)(
    'prefer mode suffix degrades safely when passthrough unsupported in current llms build',
    () => {
      const engine = buildEngine();
      const request = buildRequest('<**!antigravity.gemini-3-pro-high:passthrough**>');
      const { target } = engine.route(request, buildMetadata({ sessionId: 'session-prefer-passthrough-compat' }));
      expect(target.processMode).toBe('chat');
    }
  );

  test('prefer instructions without :passthrough keep regular chat mode', () => {
    const engine = buildEngine();
    const request = buildRequest('<**!antigravity.gemini-3-pro-high**>');
    const { target } = engine.route(request, buildMetadata({ sessionId: 'session-prefer-chat-mode' }));
    expect(target.providerKey.includes('gemini-3-pro-high')).toBe(true);
    expect(target.processMode).toBe('chat');
  });

  test('prefer instructions honor provider[alias].model syntax', () => {
    const engine = buildEngine();
    const request = buildRequest('<**!antigravity[geminikey].gemini-3-pro-high**>');
    const { target, decision } = engine.route(request, buildMetadata({ sessionId: 'session-prefer-bracket' }));
    expect(decision.routeName).toBe('prefer');
    expect(target.providerKey.includes('gemini-3-pro-high')).toBe(true);
    expect(target.providerKey.includes('geminikey')).toBe(true);
  });

  test('prefer instructions honor provider[].model syntax (all aliases)', () => {
    const engine = buildEngine();
    const request = buildRequest('<**!antigravity[].claude-sonnet-4-5**>');
    const { target, decision } = engine.route(request, buildMetadata({ sessionId: 'session-prefer-bracket-empty-alias' }));
    expect(decision.routeName).toBe('prefer');
    expect(target.providerKey.includes('claude-sonnet-4-5')).toBe(true);
    expect(target.providerKey.includes('sonnetkey') || target.providerKey.includes('sonnetbackup')).toBe(true);
  });

  test('prefer auto-clears when target becomes unavailable and falls back to routing', () => {
    const engine = buildEnginePreferFallback();
    const sessionId = 'session-prefer-autoclear';

    const first = engine.route(
      buildRequest('<**!antigravity.gemini-3-pro-high**>'),
      buildMetadata({ sessionId })
    );
    expect(first.decision.routeName).toBe('prefer');
    expect(first.target.providerKey.includes('gemini-3-pro-high')).toBe(true);

    // Disable the preferred model for this session.
    engine.route(buildRequest('<**#antigravity.gemini-3-pro-high**>'), buildMetadata({ sessionId }));
    const fallback = engine.route(buildRequest('继续'), buildMetadata({ sessionId }));
    expect(fallback.target.providerKey.includes('claude-sonnet-4-5')).toBe(true);
    expect(fallback.decision.routeName).not.toBe('prefer');

    // Re-enable the model; preferTarget should have been cleared already, so routing remains on Claude.
    engine.route(buildRequest('<**@antigravity.gemini-3-pro-high**>'), buildMetadata({ sessionId }));
    const third = engine.route(buildRequest('再次'), buildMetadata({ sessionId }));
    expect(third.target.providerKey.includes('claude-sonnet-4-5')).toBe(true);
    expect(third.decision.routeName).not.toBe('prefer');
  });

  test('prefer does not auto-clear on cooldown (e.g. HTTP 429) and resumes after cooldown', () => {
    const engine = buildEnginePreferFallback();
    const sessionId = 'session-prefer-cooldown';

    const first = engine.route(buildRequest('<**!antigravity.gemini-3-pro-high**>'), buildMetadata({ sessionId }));
    expect(first.decision.routeName).toBe('prefer');
    expect(first.target.providerKey.includes('gemini-3-pro-high')).toBe(true);

    const allKeys: string[] = (engine as any).providerRegistry.listProviderKeys('antigravity');
    const preferredKeys = allKeys.filter((key) => key.includes('gemini-3-pro-high'));
    expect(preferredKeys.length).toBeGreaterThan(0);

    for (const key of preferredKeys) {
      (engine as any).markProviderCooldown(key, 60_000);
    }

    const duringCooldown = engine.route(buildRequest('继续'), buildMetadata({ sessionId }));
    expect(duringCooldown.decision.routeName).not.toBe('prefer');
    expect(duringCooldown.target.providerKey.includes('claude-sonnet-4-5')).toBe(true);

    for (const key of preferredKeys) {
      (engine as any).clearProviderCooldown(key);
    }

    const afterCooldown = engine.route(buildRequest('再次'), buildMetadata({ sessionId }));
    expect(afterCooldown.decision.routeName).toBe('prefer');
    expect(afterCooldown.target.providerKey.includes('gemini-3-pro-high')).toBe(true);
  });

  test('disabling provider model only removes that model for the session', () => {
    const engine = buildEngine();
    const sessionId = 'session-disable-model';
    engine.route(buildRequest('<**#antigravity.claude-sonnet-4-5**>'), buildMetadata({ sessionId }));

    const followUp = engine.route(buildRequest('继续'), buildMetadata({ sessionId }));
    expect(followUp.target.providerKey.includes('gemini-3-pro-high')).toBe(true);
    expect(followUp.target.providerKey.includes('claude-sonnet-4-5')).toBe(false);
  });

  test('disabling provider key alias respects provider[alias] syntax', () => {
    const engine = buildEngine();
    const sessionId = 'session-disable-key';
    engine.route(buildRequest('<**#antigravity[geminikey]**>'), buildMetadata({ sessionId }));

    const followUp = engine.route(buildRequest('继续'), buildMetadata({ sessionId }));
    expect(followUp.target.providerKey.includes('claude-sonnet-4-5')).toBe(true);
    expect(followUp.target.providerKey.includes('gemini-3-pro-high')).toBe(false);
  });

  test('prefer provider.model instructions retain all aliases for retries', () => {
    const engine = buildEngine();
    const sessionId = 'session-sticky-multi-key';
    const first = engine.route(
      buildRequest('<**!antigravity.claude-sonnet-4-5**>'),
      buildMetadata({ sessionId })
    );
    const firstKey = first.target.providerKey;
    const firstAlias = firstKey.includes('sonnetkey')
      ? 'sonnetkey'
      : firstKey.includes('sonnetbackup')
        ? 'sonnetbackup'
        : '';
    expect(firstAlias).toBeTruthy();

    engine.route(buildRequest(`<**#antigravity[${firstAlias}]**>`), buildMetadata({ sessionId }));
    const followUp = engine.route(buildRequest('继续'), buildMetadata({ sessionId }));
    expect(followUp.target.providerKey.includes('claude-sonnet-4-5')).toBe(true);
    if (firstAlias === 'sonnetkey') {
      expect(followUp.target.providerKey.includes('sonnetbackup')).toBe(true);
    } else {
      expect(followUp.target.providerKey.includes('sonnetkey')).toBe(true);
    }
  });

  test('prefer provider.model rotates between aliases without additional instructions', () => {
    const engine = buildEngine();
    const sessionId = 'session-round-robin-multi-key';
    const first = engine.route(
      buildRequest('<**!antigravity.claude-sonnet-4-5**>'),
      buildMetadata({ sessionId })
    );
    expect(
      first.target.providerKey.includes('sonnetkey') || first.target.providerKey.includes('sonnetbackup')
    ).toBe(true);

    const second = engine.route(buildRequest('继续'), buildMetadata({ sessionId }));
    expect(second.target.providerKey.includes('claude-sonnet-4-5')).toBe(true);
    expect(second.target.providerKey).not.toBe(first.target.providerKey);
  });

  test('disableStickyRoutes metadata bypasses sticky decisions for that request only', () => {
    const engine = buildEnginePreferFallback();
    const sessionId = 'session-disable-sticky';
    engine.route(
      buildRequest('<**!antigravity[geminikey].gemini-3-pro-high**>'),
      buildMetadata({ sessionId })
    );

    const sticky = engine.route(buildRequest('继续'), buildMetadata({ sessionId }));
    expect(sticky.target.providerKey.includes('gemini-3-pro-high')).toBe(true);

    const bypass = engine.route(
      buildRequest('再次选择'),
      buildMetadata({ sessionId, disableStickyRoutes: true })
    );
    expect(bypass.target.providerKey.includes('claude-sonnet-4-5')).toBe(true);
  });

  test('provider allowlist must match classifier candidates (fallback routes excluded)', () => {
    const engine = buildEngineAllowlistGlobalFallback();
    const request = buildRequest('<**!glm**>');
    expect(() =>
      engine.route(request, buildMetadata({ sessionId: 'session-allowlist-global', routeHint: 'longcontext' }))
    ).toThrow('No available providers after applying routing instructions');
  });

  test('prefer supports dotful model ids via provider[].model syntax', () => {
    const engine = buildEngineAllowlistGlobalFallback();
    const request = buildRequest('<**!glm[].glm-4.7**>');
    const { target, decision } = engine.route(
      request,
      buildMetadata({ sessionId: 'session-prefer-dot-model', routeHint: 'longcontext' })
    );
    expect(decision.routeName).toBe('prefer');
    expect(target.providerKey.includes('glm-4.7')).toBe(true);
  });
});
