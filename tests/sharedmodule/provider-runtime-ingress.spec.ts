import {
  loadNativeRouterHotpathBindingForInternalUse
} from './helpers/native-router-hotpath-loader.js';

function callProviderRuntimeIngress<TEvent>(name: string, event?: TEvent): TEvent {
  const binding = loadNativeRouterHotpathBindingForInternalUse() as Record<string, unknown> | null;
  const fn = binding?.[name];
  if (typeof fn !== 'function') {
    throw new Error(`missing native provider runtime ingress export: ${name}`);
  }
  const raw = event === undefined ? (fn as () => unknown)() : (fn as (inputJson: string) => unknown)(JSON.stringify(event));
  if (typeof raw !== 'string' || !raw) {
    throw new Error(`empty native provider runtime ingress result: ${name}`);
  }
  return JSON.parse(raw) as TEvent;
}

function createNativeVirtualRouterEngine(): {
  initialize(config: Record<string, unknown>): void;
  registerProviderRuntimeIngress(): void;
  unregisterProviderRuntimeIngress(): void;
  getStatus(): any;
  route(request: Record<string, unknown>, metadata?: Record<string, unknown>): any;
} {
  const binding = loadNativeRouterHotpathBindingForInternalUse() as Record<string, unknown> | null;
  const ProxyCtor = binding?.VirtualRouterEngineProxy;
  if (typeof ProxyCtor !== 'function') {
    throw new Error('missing native virtual router proxy export: VirtualRouterEngineProxy');
  }
  const proxy = new (ProxyCtor as new () => {
    initialize(configJson: string): void;
    registerProviderRuntimeIngress(): void;
    unregisterProviderRuntimeIngress(): void;
    getStatus(): string;
    route(requestJson: string, metadataJson: string): string;
  })();
  return {
    initialize: (config) => proxy.initialize(JSON.stringify(config)),
    registerProviderRuntimeIngress: () => proxy.registerProviderRuntimeIngress(),
    unregisterProviderRuntimeIngress: () => proxy.unregisterProviderRuntimeIngress(),
    getStatus: () => JSON.parse(proxy.getStatus()),
    route: (request, metadata = {}) => {
      const raw = proxy.route(
        JSON.stringify(request),
        JSON.stringify({
          ...metadata,
          metadataCenterSnapshot: {
            runtimeControl: {},
            requestTruth: {
              routingPolicyGroup: metadata.routecodexRoutingPolicyGroup
            }
          }
        })
      );
      const text = String(raw);
      if (text.startsWith('Error:')) {
        throw new Error(text);
      }
      return JSON.parse(text);
    }
  };
}

function reportProviderErrorToRouterPolicy<TEvent>(event: TEvent): TEvent {
  return callProviderRuntimeIngress('reportProviderErrorToRouterPolicyJson', event);
}

function reportProviderSuccessToRouterPolicy<TEvent>(event: TEvent): TEvent {
  return callProviderRuntimeIngress('reportProviderSuccessToRouterPolicyJson', event);
}

function resetProviderRuntimeIngressForTests(): void {
  callProviderRuntimeIngress('resetProviderRuntimeIngressForTestsJson');
}

describe('provider runtime ingress', () => {
  beforeEach(() => {
    resetProviderRuntimeIngressForTests();
  });

  afterEach(() => {
    resetProviderRuntimeIngressForTests();
  });

  test('normalizes provider error events through native router policy ingress', () => {
    const before = Date.now();
    const returned = reportProviderErrorToRouterPolicy({
      code: 'HTTP_429',
      message: '',
      stage: '',
      affectsHealth: false,
      fatal: true,
      errorClassification: 'unrecoverable',
      runtime: undefined as any,
      timestamp: undefined as any,
      details: {
        source: 'unit'
      }
    } as any);

    expect(returned.code).toBe('HTTP_429');
    expect(returned.message).toBe('HTTP_429');
    expect(returned.stage).toBe('unknown');
    expect(returned.affectsHealth).toBe(false);
    expect(returned.fatal).toBe(true);
    expect(returned.cooldownOverrideMs).toBeUndefined();
    expect(returned.errorClassification).toBe('unrecoverable');
    expect(returned.runtime).toEqual({});
    expect(returned.timestamp).toBeGreaterThanOrEqual(before);
  });

  test('normalizes provider success events through native router policy ingress', () => {
    const before = Date.now();
    const returned = reportProviderSuccessToRouterPolicy({
      runtime: undefined as any,
      timestamp: undefined as any,
      metadata: {
        source: 'unit'
      }
    } as any);

    expect(returned.runtime).toEqual({});
    expect(returned.timestamp).toBeGreaterThanOrEqual(before);
    expect(returned.metadata).toEqual({ source: 'unit' });
  });

  test('HTTP_502 reports mutate only the matching routingPolicyGroup runtime health', () => {
    const providerKey = 'primary.key1.gpt-test';
    const backupKey = 'backup.key1.gpt-test';
    const engine = createNativeVirtualRouterEngine();
    engine.initialize({
      routingPolicyGroup: 'gateway_priority_5520',
      routing: {
        thinking: [
          {
            id: 'thinking-primary',
            priority: 100,
            mode: 'priority',
            targets: [providerKey, backupKey]
          }
        ],
        default: [
          {
            id: 'default-primary',
            priority: 10,
            mode: 'priority',
            targets: [providerKey, backupKey]
          }
        ]
      },
      providers: {
        [providerKey]: {
          providerKey,
          providerType: 'openai',
          endpoint: 'http://example.invalid',
          auth: { type: 'apiKey', value: 'test-key' },
          outboundProfile: 'openai-chat',
          runtimeKey: 'primary.key1',
          modelId: 'gpt-test'
        },
        [backupKey]: {
          providerKey: backupKey,
          providerType: 'openai',
          endpoint: 'http://example.invalid',
          auth: { type: 'apiKey', value: 'test-key' },
          outboundProfile: 'openai-chat',
          runtimeKey: 'backup.key1',
          modelId: 'gpt-test'
        }
      },
      classifier: {},
      loadBalancing: { strategy: 'priority' },
      health: {
        failureThreshold: 3,
        cooldownMs: 30_000
      }
    } as any);
    engine.registerProviderRuntimeIngress();
    try {
      for (let index = 1; index <= 3; index += 1) {
        reportProviderErrorToRouterPolicy({
          code: 'HTTP_502',
          message: `upstream 502 #${index}`,
          stage: 'provider.send',
          status: 502,
          recoverable: true,
          affectsHealth: true,
          errorClassification: 'recoverable',
          runtime: {
            requestId: `req-http-502-${index}`,
            providerKey,
            runtimeKey: 'primary.key1',
            routeName: 'thinking',
            routecodexRoutingPolicyGroup: 'gateway_priority_5520'
          },
          timestamp: Date.now()
        } as any);
        reportProviderSuccessToRouterPolicy({
          runtime: {
            requestId: `req-backup-success-after-http-502-${index}`,
            providerKey: backupKey,
            runtimeKey: 'primary.key1',
            routeName: 'thinking',
            routecodexRoutingPolicyGroup: 'gateway_priority_5520'
          },
          timestamp: Date.now()
        } as any);
      }

      const status = engine.getStatus();
      const primaryState = status.health.find((entry) => entry.providerKey === 'primary.1.gpt-test');
      expect(primaryState).toMatchObject({
        state: 'tripped',
        failureCount: 3
      });

      const routed = engine.route(
        { model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }] },
        { routecodexRoutingPolicyGroup: 'gateway_priority_5520' }
      );
      expect(routed.target.providerKey).toBe(backupKey);
    } finally {
      engine.unregisterProviderRuntimeIngress();
    }
  });
});
