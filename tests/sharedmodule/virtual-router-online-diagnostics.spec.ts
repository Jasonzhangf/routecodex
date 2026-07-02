import { VirtualRouterEngine } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-runtime.js';

function buildMetadata(requestId: string): Record<string, unknown> {
  return {
    requestId,
    metadataCenterSnapshot: {
      request: { requestId },
      runtimeControl: {}
    }
  };
}

function buildConfig(): Record<string, unknown> {
  return {
    routing: {
      default: [
        {
          id: 'default-primary',
          priority: 100,
          mode: 'round-robin',
          targets: ['fwd.gpt.gpt-test']
        }
      ],
      longcontext: [
        {
          id: 'longcontext-primary',
          priority: 100,
          mode: 'priority',
          targets: ['fwd.gpt.gpt-test']
        }
      ]
    },
    providers: {
      'sdfv.key1.gpt-test': {
        providerKey: 'sdfv.key1.gpt-test',
        providerType: 'openai-responses',
        endpoint: 'https://example.invalid',
        auth: { type: 'apiKey', value: 'test-key' },
        outboundProfile: 'openai-responses',
        runtimeKey: 'sdfv.key1',
        modelId: 'gpt-test',
        enabled: true
      },
      'one.key1.gpt-test': {
        providerKey: 'one.key1.gpt-test',
        providerType: 'openai-responses',
        endpoint: 'https://example.invalid',
        auth: { type: 'apiKey', value: 'test-key' },
        outboundProfile: 'openai-responses',
        runtimeKey: 'one.key1',
        modelId: 'gpt-test',
        enabled: true
      }
    },
    forwarders: {
      'fwd.gpt.gpt-test': {
        forwarderId: 'fwd.gpt.gpt-test',
        protocol: 'openai-responses',
        modelId: 'gpt-test',
        resolutionMode: 'model-first',
        strategy: 'round-robin',
        targets: [
          { providerKey: 'sdfv.key1.gpt-test', weight: null, priority: null, disabled: false },
          { providerKey: 'one.key1.gpt-test', weight: null, priority: null, disabled: false }
        ],
        stickyKey: 'none'
      }
    },
    classifier: {},
    loadBalancing: { strategy: 'round-robin' }
  };
}

describe('virtual router online diagnostics', () => {
  it('expands status routes into pools, configured targets, resolved forwarders, and target availability', () => {
    const engine = new VirtualRouterEngine();
    engine.initialize(buildConfig() as any);

    const status = engine.getStatus() as any;
    const defaultRoute = status.routes.default;

    expect(defaultRoute.pools).toEqual([
      expect.objectContaining({
        routeName: 'default',
        poolId: 'default-primary',
        configuredTargets: ['fwd.gpt.gpt-test'],
        resolvedForwarders: [
          expect.objectContaining({
            forwarderId: 'fwd.gpt.gpt-test',
            targetProviderKeys: ['sdfv.key1.gpt-test', 'one.key1.gpt-test']
          })
        ],
        availableTargets: ['sdfv.key1.gpt-test', 'one.key1.gpt-test']
      })
    ]);
  });

  it('dry-runs through Rust VR without advancing round-robin state', () => {
    const engine = new VirtualRouterEngine();
    engine.initialize(buildConfig() as any);

    const request = { messages: [{ role: 'user', content: 'hello' }] };
    const dryRun = (engine as any).diagnoseRoute(request, buildMetadata('req-diag-dry-run'));
    const firstLive = engine.route(request as any, buildMetadata('req-live-1') as any);
    const secondLive = engine.route(request as any, buildMetadata('req-live-2') as any);

    expect(dryRun.ok).toBe(true);
    expect(dryRun.decision).toEqual(expect.objectContaining({
      selectedRouteName: 'default',
      selectedProviderKey: 'sdfv.key1.gpt-test',
      wouldReturnProviderNotAvailable: false
    }));
    expect(firstLive.target.providerKey).toBe('sdfv.key1.gpt-test');
    expect(secondLive.target.providerKey).toBe('one.key1.gpt-test');
  });

  it('dry-run accepts minimal diagnostic metadata and builds the Rust metadata snapshot envelope', () => {
    const engine = new VirtualRouterEngine();
    engine.initialize(buildConfig() as any);

    const dryRun = (engine as any).diagnoseRoute(
      { messages: [{ role: 'user', content: 'hello' }] },
      { requestId: 'req-diag-minimal' }
    );

    expect(dryRun.ok).toBe(true);
    expect(dryRun.decision).toEqual(expect.objectContaining({
      selectedRouteName: 'default',
      selectedProviderKey: 'sdfv.key1.gpt-test'
    }));
  });

  it('dry-run returns structured provider-unavailable explanation', () => {
    const engine = new VirtualRouterEngine();
    engine.initialize(buildConfig() as any);

    const dryRun = (engine as any).diagnoseRoute(
      { messages: [{ role: 'user', content: 'hello' }] },
      {
        ...buildMetadata('req-diag-unavailable'),
        metadataCenterSnapshot: {
          requestId: 'req-diag-unavailable',
          excludedProviderKeys: ['sdfv.key1.gpt-test', 'one.key1.gpt-test'],
          runtimeControl: {}
        }
      }
    );

    expect(dryRun.ok).toBe(false);
    expect(dryRun.error).toEqual(expect.objectContaining({
      code: 'PROVIDER_NOT_AVAILABLE',
      details: expect.objectContaining({
        candidateProviderKeys: expect.arrayContaining(['fwd.gpt.gpt-test']),
        unavailableRoutePools: expect.any(Array)
      })
    }));
  });

  it('dry-run merges top-level excludedProviderKeys into an existing metadataCenterSnapshot', () => {
    const engine = new VirtualRouterEngine();
    engine.initialize(buildConfig() as any);

    const dryRun = (engine as any).diagnoseRoute(
      { messages: [{ role: 'user', content: 'hello' }] },
      {
        ...buildMetadata('req-diag-top-level-excluded'),
        excludedProviderKeys: ['sdfv.key1.gpt-test'],
        metadataCenterSnapshot: {
          requestId: 'req-diag-top-level-excluded',
          runtimeControl: {}
        }
      }
    );

    expect(dryRun.ok).toBe(true);
    expect(dryRun.decision).toEqual(expect.objectContaining({
      selectedRouteName: 'default',
      selectedProviderKey: 'one.key1.gpt-test'
    }));
  });
});
