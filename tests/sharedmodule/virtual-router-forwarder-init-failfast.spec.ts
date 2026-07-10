import { VirtualRouterEngine } from './helpers/virtual-router-engine-direct-native.js';

function invalidForwarderConfig() {
  return {
    providers: {
      'primary.key1.gpt-5.5': {
        providerKey: 'primary.key1.gpt-5.5',
        providerType: 'openai',
        modelId: 'gpt-5.5',
        enabled: true,
        maxContextTokens: 900000
      },
      'backup.key1.gpt-5.5': {
        providerKey: 'backup.key1.gpt-5.5',
        providerType: 'openai',
        modelId: 'gpt-5.5',
        enabled: true,
        maxContextTokens: 900000
      }
    },
    routing: {
      thinking: [
        {
          id: 'thinking-with-forwarder',
          priority: 100,
          mode: 'priority',
          targets: ['fwd.gpt.gpt-5.5', 'backup.key1.gpt-5.5']
        }
      ]
    },
    forwarders: {
      'fwd.gpt.gpt-5.5': {
        forwarderId: 'fwd.gpt.gpt-5.5',
        protocol: 'openai',
        modelId: 'gpt-5.5',
        resolutionMode: 'model-first',
        strategy: 'priority',
        stickyKey: 'session',
        targets: [
          {
            providerKey: 'missing.key1.gpt-5.5',
            priority: 1,
            disabled: false
          }
        ]
      }
    }
  };
}

describe('VirtualRouter forwarder initialization fail-fast', () => {
  it('throws when a forwarder target references an unknown provider key', () => {
    const engine = new VirtualRouterEngine();

    expect(() => engine.initialize(invalidForwarderConfig() as any)).toThrow(
      /forwarder config invalid: forwarder 'fwd\.gpt\.gpt-5\.5' references unknown provider_key 'missing\.key1\.gpt-5\.5'/
    );
  });

  it('throws on updateVirtualRouterConfig instead of silently keeping an empty forwarder registry', () => {
    const engine = new VirtualRouterEngine();
    engine.initialize({
      providers: {
        'primary.key1.gpt-5.5': {
          providerKey: 'primary.key1.gpt-5.5',
          providerType: 'openai',
          modelId: 'gpt-5.5',
          enabled: true,
          maxContextTokens: 900000
        }
      },
      routing: {
        thinking: [
          {
            id: 'thinking-primary',
            priority: 100,
            mode: 'priority',
            targets: ['primary.key1.gpt-5.5']
          }
        ]
      }
    } as any);

    expect(() => engine.updateVirtualRouterConfig(invalidForwarderConfig() as any)).toThrow(
      /forwarder config invalid/
    );
  });
});
