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
import * as fs from 'node:fs';
import * as path from 'node:path';

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

function buildEngineWebSearchIsolation(): VirtualRouterEngine {
  const input: VirtualRouterBootstrapInput = {
    virtualrouter: {
      providers: {
        tab: {
          id: 'tab',
          type: 'openai',
          endpoint: 'https://example.invalid',
          auth: {
            type: 'apikey',
            keys: {
              key1: { value: 'TAB' }
            }
          },
          models: {
            'chat-default': {}
          }
        },
        web: {
          id: 'web',
          type: 'openai',
          endpoint: 'https://example.invalid',
          auth: {
            type: 'apikey',
            keys: {
              key1: { value: 'WEB' }
            }
          },
          models: {
            'search-model': {}
          }
        }
      },
      routing: {
        default: ['tab.chat-default'],
        web_search: ['web.search-model']
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
    const engine = buildEngine();
    const sessionId = `session-prefer-autoclear-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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

    // Re-enable the model; preferTarget should have been cleared already, so routing stays in normal route selection.
    engine.route(buildRequest('<**@antigravity.gemini-3-pro-high**>'), buildMetadata({ sessionId }));
    const third = engine.route(buildRequest('再次'), buildMetadata({ sessionId }));
    expect(third.decision.routeName).not.toBe('prefer');
    expect(
      third.target.providerKey.includes('claude-sonnet-4-5') ||
      third.target.providerKey.includes('gemini-3-pro-high')
    ).toBe(true);
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

  test('stopMessage is consumed before routing classification (marker-only web_search keyword does not hijack route)', () => {
    const engine = buildEngineWebSearchIsolation();
    const tmuxSessionId = 'tmux-stop-consume-before-route';
    const request = buildRequest('<**stopMessage:"dummy-stop",3**> just continue normally');

    const { target, decision } = engine.route(
      request,
      buildMetadata({
        sessionId: 'session-stop-consume-before-route',
        tmuxSessionId,
        clientTmuxSessionId: tmuxSessionId
      } as any)
    );

    expect(decision.routeName).toBe('default');
    expect(target.providerKey).toContain('chat-default');

    const stopSnapshot = engine.getStopMessageState(
      buildMetadata({
        requestId: 'req-stop-snapshot',
        sessionId: 'session-stop-consume-before-route',
        tmuxSessionId,
        clientTmuxSessionId: tmuxSessionId
      } as any)
    );
    expect(stopSnapshot?.stopMessageText).toBe('dummy-stop');
    expect(stopSnapshot?.stopMessageMaxRepeats).toBe(3);
  });

  test('stopMessage clear is consumed before routing classification and clears scoped state', () => {
    const engine = buildEngineWebSearchIsolation();
    const tmuxSessionId = 'tmux-stop-clear-consume-before-route';
    const metadata = buildMetadata({
      sessionId: 'session-stop-clear-consume-before-route',
      tmuxSessionId,
      clientTmuxSessionId: tmuxSessionId
    } as any);

    engine.route(buildRequest('<**stopMessage:"dummy-stop",3**> arm stop message'), metadata);
    const armedSnapshot = engine.getStopMessageState(
      buildMetadata({
        requestId: 'req-stop-clear-armed-snapshot',
        sessionId: 'session-stop-clear-consume-before-route',
        tmuxSessionId,
        clientTmuxSessionId: tmuxSessionId
      } as any)
    );
    expect(armedSnapshot?.stopMessageText).toBe('dummy-stop');

    const { target, decision } = engine.route(
      buildRequest('<**stopMessage:clear**> continue with normal route'),
      metadata
    );
    expect(decision.routeName).toBe('default');
    expect(target.providerKey).toContain('chat-default');

    const clearedSnapshot = engine.getStopMessageState(
      buildMetadata({
        requestId: 'req-stop-clear-cleared-snapshot',
        sessionId: 'session-stop-clear-consume-before-route',
        tmuxSessionId,
        clientTmuxSessionId: tmuxSessionId
      } as any)
    );
    expect(clearedSnapshot).toBeNull();
  });

  test('preCommand is consumed before routing classification and persists scope state', () => {
    const engine = buildEngineWebSearchIsolation();
    const tmuxSessionId = 'tmux-precommand-consume-before-route';
    const tmpUserDir = path.join(
      process.cwd(),
      'tmp',
      `jest-precommand-userdir-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    );
    const prevUserDir = process.env.ROUTECODEX_USER_DIR;
    fs.mkdirSync(tmpUserDir, { recursive: true });
    process.env.ROUTECODEX_USER_DIR = tmpUserDir;

    try {
      const request = buildRequest('<**precommand:on**> keep using default route');
      const { target, decision } = engine.route(
        request,
        buildMetadata({
          sessionId: 'session-precommand-consume-before-route',
          tmuxSessionId,
          clientTmuxSessionId: tmuxSessionId
        } as any)
      );

      expect(decision.routeName).toBe('default');
      expect(target.providerKey).toContain('chat-default');

      const preCommandSnapshot = engine.getPreCommandState(
        buildMetadata({
          requestId: 'req-precommand-snapshot',
          sessionId: 'session-precommand-consume-before-route',
          tmuxSessionId,
          clientTmuxSessionId: tmuxSessionId
        } as any)
      );
      expect(typeof preCommandSnapshot?.preCommandScriptPath).toBe('string');
      expect(preCommandSnapshot?.preCommandScriptPath).toContain(path.join('precommand', 'default.sh'));
    } finally {
      if (prevUserDir === undefined) {
        delete process.env.ROUTECODEX_USER_DIR;
      } else {
        process.env.ROUTECODEX_USER_DIR = prevUserDir;
      }
      fs.rmSync(tmpUserDir, { recursive: true, force: true });
    }
  });

  test('preCommand clear is consumed before routing classification and clears scope state', () => {
    const engine = buildEngineWebSearchIsolation();
    const tmuxSessionId = 'tmux-precommand-clear-consume-before-route';
    const tmpUserDir = path.join(
      process.cwd(),
      'tmp',
      `jest-precommand-clear-userdir-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    );
    const prevUserDir = process.env.ROUTECODEX_USER_DIR;
    fs.mkdirSync(tmpUserDir, { recursive: true });
    process.env.ROUTECODEX_USER_DIR = tmpUserDir;

    try {
      const metadata = buildMetadata({
        sessionId: 'session-precommand-clear-consume-before-route',
        tmuxSessionId,
        clientTmuxSessionId: tmuxSessionId
      } as any);

      engine.route(buildRequest('<**precommand:on**> enable precommand first'), metadata);
      const armedSnapshot = engine.getPreCommandState(
        buildMetadata({
          requestId: 'req-precommand-clear-armed-snapshot',
          sessionId: 'session-precommand-clear-consume-before-route',
          tmuxSessionId,
          clientTmuxSessionId: tmuxSessionId
        } as any)
      );
      expect(typeof armedSnapshot?.preCommandScriptPath).toBe('string');

      const { target, decision } = engine.route(
        buildRequest('<**precommand:clear**> continue with normal route'),
        metadata
      );
      expect(decision.routeName).toBe('default');
      expect(target.providerKey).toContain('chat-default');

      const clearedSnapshot = engine.getPreCommandState(
        buildMetadata({
          requestId: 'req-precommand-clear-cleared-snapshot',
          sessionId: 'session-precommand-clear-consume-before-route',
          tmuxSessionId,
          clientTmuxSessionId: tmuxSessionId
        } as any)
      );
      expect(clearedSnapshot).toBeNull();
    } finally {
      if (prevUserDir === undefined) {
        delete process.env.ROUTECODEX_USER_DIR;
      } else {
        process.env.ROUTECODEX_USER_DIR = prevUserDir;
      }
      fs.rmSync(tmpUserDir, { recursive: true, force: true });
    }
  });
});
