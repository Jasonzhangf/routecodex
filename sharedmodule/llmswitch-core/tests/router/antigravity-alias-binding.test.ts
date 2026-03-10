import { describe, expect, test } from '@jest/globals';

import { VirtualRouterEngine } from '../../src/router/virtual-router/engine.js';

function mkConfig(): any {
  const auth = { type: 'oauth' as const, tokenFile: '/tmp/fake.json' };
  return {
    routing: {
      default: [
        {
          id: 'default-primary',
          priority: 100,
          mode: 'round-robin',
          targets: ['antigravity.a.gemini-3-pro-high', 'antigravity.b.gemini-3-pro-high']
        }
      ],
      thinking: [
        {
          id: 'thinking-primary',
          priority: 200,
          mode: 'round-robin',
          targets: ['antigravity.a.gemini-3-pro-high', 'antigravity.b.gemini-3-pro-high']
        }
      ]
    },
    providers: {
      'antigravity.a.gemini-3-pro-high': {
        providerKey: 'antigravity.a.gemini-3-pro-high',
        providerType: 'gemini',
        endpoint: 'http://example.invalid',
        auth,
        outboundProfile: 'chat:gemini',
        runtimeKey: 'antigravity.a',
        modelId: 'gemini-3-pro-high'
      },
      'antigravity.b.gemini-3-pro-high': {
        providerKey: 'antigravity.b.gemini-3-pro-high',
        providerType: 'gemini',
        endpoint: 'http://example.invalid',
        auth,
        outboundProfile: 'chat:gemini',
        runtimeKey: 'antigravity.b',
        modelId: 'gemini-3-pro-high'
      }
    },
    classifier: {},
    loadBalancing: {}
  };
}

function getSessionAliasStore(engine: VirtualRouterEngine): Map<string, string> {
  return (engine as any).antigravitySessionAliasStore as Map<string, string>;
}

describe('antigravity alias session binding', () => {
  test('commits binding only after provider success', () => {
    const engine = new VirtualRouterEngine({} as any);
    engine.initialize(mkConfig());

    const req = { model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }], tools: [] } as any;
    const meta = { requestId: 'req_1', sessionId: 's1', routeHint: 'thinking' } as any;

    const result = engine.route(req, meta);

    const sessionStore = getSessionAliasStore(engine);
    expect(sessionStore.size).toBe(0);

    engine.handleProviderSuccess({
      runtime: { requestId: 'req_1', providerKey: result.target.providerKey },
      timestamp: Date.now(),
      metadata: { sessionId: 's1' }
    } as any);

    expect(sessionStore.get('session:s1::gemini')).toBe('antigravity.a::gemini');
  });

  test('releases a bound alias when quota marks it out of pool', () => {
    const engine = new VirtualRouterEngine({} as any);
    engine.initialize(mkConfig());

    const req = { model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }], tools: [] } as any;
    const meta = { requestId: 'req_1', sessionId: 's1', routeHint: 'thinking' } as any;

    const first = engine.route(req, meta);
    engine.handleProviderSuccess({
      runtime: { requestId: 'req_1', providerKey: first.target.providerKey },
      timestamp: Date.now(),
      metadata: { sessionId: 's1' }
    } as any);

    const sessionStore = getSessionAliasStore(engine);
    expect(sessionStore.get('session:s1::gemini')).toBe('antigravity.a::gemini');

    engine.updateDeps({
      quotaView: (providerKey: string) => {
        if (providerKey.startsWith('antigravity.a.')) {
          return { providerKey, inPool: false };
        }
        return { providerKey, inPool: true };
      }
    } as any);

    const second = engine.route({ ...req, messages: [{ role: 'user', content: 'again' }] } as any, {
      ...meta,
      requestId: 'req_2'
    } as any);

    expect(sessionStore.has('session:s1::gemini')).toBe(false);
    expect(String(second.target.providerKey)).toContain('antigravity.b.');
  });

  test('does not bind for non-gemini antigravity models', () => {
    const engine = new VirtualRouterEngine({} as any);
    const cfg = mkConfig();
    cfg.routing.thinking[0].targets = ['antigravity.a.claude-sonnet-4-5-thinking', 'antigravity.b.claude-sonnet-4-5-thinking'];
    cfg.providers = {
      'antigravity.a.claude-sonnet-4-5-thinking': {
        providerKey: 'antigravity.a.claude-sonnet-4-5-thinking',
        providerType: 'gemini',
        endpoint: 'http://example.invalid',
        auth: { type: 'oauth' as const, tokenFile: '/tmp/fake.json' },
        outboundProfile: 'chat:gemini',
        runtimeKey: 'antigravity.a',
        modelId: 'claude-sonnet-4-5-thinking'
      },
      'antigravity.b.claude-sonnet-4-5-thinking': {
        providerKey: 'antigravity.b.claude-sonnet-4-5-thinking',
        providerType: 'gemini',
        endpoint: 'http://example.invalid',
        auth: { type: 'oauth' as const, tokenFile: '/tmp/fake.json' },
        outboundProfile: 'chat:gemini',
        runtimeKey: 'antigravity.b',
        modelId: 'claude-sonnet-4-5-thinking'
      }
    };
    engine.initialize(cfg);

    const req = { model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }], tools: [] } as any;
    const meta = { requestId: 'req_1', sessionId: 's1', routeHint: 'thinking' } as any;
    const result = engine.route(req, meta);
    engine.handleProviderSuccess({
      runtime: { requestId: 'req_1', providerKey: result.target.providerKey },
      timestamp: Date.now(),
      metadata: { sessionId: 's1' }
    } as any);

    const sessionStore = getSessionAliasStore(engine);
    expect(sessionStore.size).toBe(0);
  });

  test('supports per-request disabling via metadata.__rt', () => {
    const engine = new VirtualRouterEngine({} as any);
    engine.initialize(mkConfig());

    const req = { model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }], tools: [] } as any;
    const meta = { requestId: 'req_1', sessionId: 's1', routeHint: 'thinking', __rt: { disableAntigravitySessionBinding: true } } as any;

    const result = engine.route(req, meta);
    engine.handleProviderSuccess({
      runtime: { requestId: 'req_1', providerKey: result.target.providerKey },
      timestamp: Date.now(),
      metadata: meta
    } as any);

    const sessionStore = getSessionAliasStore(engine);
    expect(sessionStore.size).toBe(0);
  });
});
