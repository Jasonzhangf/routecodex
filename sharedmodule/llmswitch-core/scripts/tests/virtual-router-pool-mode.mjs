import assert from 'node:assert/strict';
import { VirtualRouterEngine } from '../../dist/native/router-hotpath/native-virtual-router-runtime.js';
import { bootstrapVirtualRouterConfig } from '../../dist/native/router-hotpath/native-virtual-router-bootstrap-config.js';

function createRequest(content) {
  return {
    model: 'gpt-5.2',
    messages: [{ role: 'user', content }],
    parameters: {},
    metadata: { originalEndpoint: '/v1/chat/completions' }
  };
}

function createMetadata(requestId, sessionId) {
  const resolvedSessionId = sessionId ?? 'virtual_router_pool_mode_session';
  return {
    requestId,
    sessionId: resolvedSessionId,
    entryEndpoint: '/v1/chat/completions',
    processMode: 'chat',
    stream: false,
    direction: 'request',
    metadataCenterSnapshot: {
      requestId,
      sessionId: resolvedSessionId,
      runtimeControl: {
        entryEndpoint: '/v1/chat/completions',
        processMode: 'chat',
        stream: false,
        direction: 'request'
      }
    }
  };
}

console.log('🧪 virtual-router pool mode tests...');

// 1) priority mode: stay on the first available target, fallback when unavailable, then re-enter on recovery.
{
  const input = {
    virtualrouter: {
      providers: {
        tab: {
          type: 'openai',
          endpoint: 'http://localhost',
          auth: {
            type: 'apikey',
            keys: {
              key1: { value: 'dummy1' },
              key2: { value: 'dummy2' }
            }
          }
        }
      },
      routing: {
        default: [
          {
            id: 'default:p0',
            priority: 100,
            mode: 'priority',
            targets: ['tab.key1.gpt-5.2:200', 'tab.key2.gpt-5.2']
          }
        ]
      },
      classifier: {}
    }
  };

  const { config } = bootstrapVirtualRouterConfig(input);
  const engine = new VirtualRouterEngine();
  engine.initialize(config);

  const r1 = engine.route(createRequest('hello'), createMetadata('req_priority_1'));
  assert.equal(r1.target.providerKey, 'tab.key1.gpt-5.2', 'priority mode should start with the first candidate');

  const r2 = engine.route(createRequest('hello2'), createMetadata('req_priority_2'));
  assert.equal(
    r2.target.providerKey,
    'tab.key1.gpt-5.2',
    'priority mode should keep the first available candidate'
  );

  engine.markProviderCooldown('tab.key1.gpt-5.2', 30_000);
  const r3 = engine.route(createRequest('hello3'), createMetadata('req_priority_3'));
  assert.equal(r3.target.providerKey, 'tab.key2.gpt-5.2', 'priority mode should fallback when key becomes unavailable');

  engine.clearProviderCooldown('tab.key1.gpt-5.2');
  const r4 = engine.route(createRequest('hello4'), createMetadata('req_priority_4')).target.providerKey;
  assert.equal(r4, 'tab.key1.gpt-5.2', 'priority mode should re-include recovered primary key');
}

// 2) round-robin mode: should rotate within the pool (existing behaviour via load balancer).
{
  const input = {
    virtualrouter: {
      providers: {
        tab: {
          type: 'openai',
          endpoint: 'http://localhost',
          auth: {
            type: 'apikey',
            keys: {
              key1: { value: 'dummy1' },
              key2: { value: 'dummy2' }
            }
          }
        }
      },
      routing: {
        default: [
          {
            id: 'default:rr',
            priority: 100,
            mode: 'round-robin',
            targets: ['tab.key1.gpt-5.2:200', 'tab.key2.gpt-5.2:100']
          }
        ]
      },
      loadBalancing: { strategy: 'sticky' },
      classifier: {}
    }
  };

  const { config } = bootstrapVirtualRouterConfig(input);
  const engine = new VirtualRouterEngine();
  engine.initialize(config);

  const sessionId = 'sticky_session';
  const a = engine.route(createRequest('a'), createMetadata('req_rr_1', sessionId)).target.providerKey;
  const b = engine.route(createRequest('b'), createMetadata('req_rr_2', sessionId)).target.providerKey;
  const c = engine.route(createRequest('c'), createMetadata('req_rr_3', sessionId)).target.providerKey;
  assert.equal(a, 'tab.key1.gpt-5.2');
  assert.equal(b, 'tab.key2.gpt-5.2');
  assert.equal(c, 'tab.key1.gpt-5.2');
}

// 3) single-provider default route keeps the default floor non-empty during native cooldown.
{
  const input = {
    virtualrouter: {
      providers: {
        tab: {
          type: 'openai',
          endpoint: 'http://localhost',
          auth: {
            type: 'apikey',
            keys: {
              key1: { value: 'dummy1' }
            }
          }
        }
      },
      routing: {
        default: [
          {
            id: 'default:single',
            priority: 100,
            mode: 'priority',
            targets: ['tab.key1.gpt-5.2']
          }
        ]
      },
      classifier: {}
    }
  };

  const { config } = bootstrapVirtualRouterConfig(input);
  const engine = new VirtualRouterEngine();
  engine.initialize(config);

  engine.markProviderCooldown('tab.key1.gpt-5.2', 30_000);
  const result = engine.route(createRequest('cooldown'), createMetadata('req_single_cooldown'));
  assert.equal(result.target.providerKey, 'tab.key1.gpt-5.2', 'default floor should keep the singleton provider selectable');
  assert.equal(result.decision.routeName, 'default');
  engine.clearProviderCooldown('tab.key1.gpt-5.2');
}

// 4) default route keeps the default floor non-empty when all candidates are in native cooldown.
{
  const input = {
    virtualrouter: {
      providers: {
        tab: {
          type: 'openai',
          endpoint: 'http://localhost',
          auth: {
            type: 'apikey',
            keys: {
              key1: { value: 'dummy1' },
              key2: { value: 'dummy2' }
            }
          }
        }
      },
      routing: {
        default: [
          {
            id: 'default:all-blocked',
            priority: 100,
            mode: 'priority',
            targets: ['tab.key1.gpt-5.2', 'tab.key2.gpt-5.2']
          }
        ]
      },
      classifier: {}
    }
  };

  const { config } = bootstrapVirtualRouterConfig(input);
  const engine = new VirtualRouterEngine();
  engine.initialize(config);

  engine.markProviderCooldown('tab.key1.gpt-5.2', 30_000);
  engine.markProviderCooldown('tab.key2.gpt-5.2', 30_000);
  const result = engine.route(createRequest('cooldown_all'), createMetadata('req_all_cooldown'));
  assert.ok(
    ['tab.key1.gpt-5.2', 'tab.key2.gpt-5.2'].includes(result.target.providerKey),
    'default floor should keep one default candidate selectable'
  );
  assert.equal(result.decision.routeName, 'default');
  engine.clearProviderCooldown('tab.key1.gpt-5.2');
  engine.clearProviderCooldown('tab.key2.gpt-5.2');
}

// 5) weighted pool selection must balance by provider.model group, not by runtime-key count.
{
  const input = {
    virtualrouter: {
      providers: {
        ag: {
          type: 'openai',
          endpoint: 'http://localhost',
          auth: {
            type: 'apikey',
            keys: {
              key1: { value: 'dummy1' },
              key2: { value: 'dummy2' },
              key3: { value: 'dummy3' }
            }
          }
        },
        tab: {
          type: 'openai',
          endpoint: 'http://localhost',
          auth: {
            type: 'apikey',
            keys: {
              key1: { value: 'dummy4' }
            }
          }
        }
      },
      routing: {
        default: [
          {
            id: 'default:weighted-groups',
            priority: 100,
            loadBalancing: {
              strategy: 'weighted',
              weights: {
                'ag.claude-sonnet-4-6-thinking': 1,
                'tab.glm-5': 1
              }
            },
            targets: [
              'ag.key1.claude-sonnet-4-6-thinking',
              'ag.key2.claude-sonnet-4-6-thinking',
              'ag.key3.claude-sonnet-4-6-thinking',
              'tab.key1.glm-5'
            ]
          }
        ]
      },
      classifier: {}
    }
  };

  const { config } = bootstrapVirtualRouterConfig(input);
  const engine = new VirtualRouterEngine();
  engine.initialize(config);

  const counts = new Map([
    ['ag.claude-sonnet-4-6-thinking', 0],
    ['tab.glm-5', 0]
  ]);
  const sequence = [];
  for (let i = 0; i < 8; i += 1) {
    const key = engine.route(createRequest(`code${i}`), createMetadata(`req_group_weight_${i}`)).target.providerKey;
    sequence.push(key);
    const bucket = key.startsWith('ag.') ? 'ag.claude-sonnet-4-6-thinking' : 'tab.glm-5';
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }

  assert.equal(counts.get('ag.claude-sonnet-4-6-thinking'), 4, 'multi-key provider.model should keep only its configured pool share');
  assert.equal(counts.get('tab.glm-5'), 4, 'single-key provider.model should receive the same configured pool share');
  assert.deepEqual(
    sequence,
    [
      'ag.key1.claude-sonnet-4-6-thinking',
      'tab.key1.glm-5',
      'ag.key2.claude-sonnet-4-6-thinking',
      'tab.key1.glm-5',
      'ag.key3.claude-sonnet-4-6-thinking',
      'tab.key1.glm-5',
      'ag.key1.claude-sonnet-4-6-thinking',
      'tab.key1.glm-5'
    ],
    'weighted group routing should alternate by provider.model group and rotate keys only inside the selected group'
  );
}

// 6) priority pools must stay inside the first available provider.model group instead of crossing groups by key count.
{
  const input = {
    virtualrouter: {
      providers: {
        ag: {
          type: 'openai',
          endpoint: 'http://localhost',
          auth: {
            type: 'apikey',
            keys: {
              key1: { value: 'dummy1' },
              key2: { value: 'dummy2' }
            }
          }
        },
        tab: {
          type: 'openai',
          endpoint: 'http://localhost',
          auth: {
            type: 'apikey',
            keys: {
              key1: { value: 'dummy3' }
            }
          }
        }
      },
      routing: {
        default: [
          {
            id: 'default:priority-groups',
            priority: 100,
            mode: 'priority',
            targets: [
              'ag.key1.claude-sonnet-4-6-thinking',
              'ag.key2.claude-sonnet-4-6-thinking',
              'tab.key1.glm-5'
            ]
          }
        ]
      },
      classifier: {}
    }
  };

  const { config } = bootstrapVirtualRouterConfig(input);
  const engine = new VirtualRouterEngine();
  engine.initialize(config);

  const p1 = engine.route(createRequest('prio1'), createMetadata('req_priority_group_1')).target.providerKey;
  const p2 = engine.route(createRequest('prio2'), createMetadata('req_priority_group_2')).target.providerKey;
  const p3 = engine.route(createRequest('prio3'), createMetadata('req_priority_group_3')).target.providerKey;
  assert.equal(p1, 'ag.key1.claude-sonnet-4-6-thinking');
  assert.equal(p2, 'ag.key1.claude-sonnet-4-6-thinking');
  assert.equal(p3, 'ag.key1.claude-sonnet-4-6-thinking');

  engine.markProviderCooldown('ag.key1.claude-sonnet-4-6-thinking', 30_000);
  engine.markProviderCooldown('ag.key2.claude-sonnet-4-6-thinking', 30_000);
  const fallback = engine.route(createRequest('prio4'), createMetadata('req_priority_group_4')).target.providerKey;
  assert.equal(fallback, 'tab.key1.glm-5', 'priority pools should only move to the next provider.model group after the first one is unavailable');
  engine.clearProviderCooldown('ag.key1.claude-sonnet-4-6-thinking');
  engine.clearProviderCooldown('ag.key2.claude-sonnet-4-6-thinking');
}

console.log('✅ virtual-router pool mode tests passed');
