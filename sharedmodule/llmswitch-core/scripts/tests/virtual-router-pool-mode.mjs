import assert from 'node:assert/strict';
import { VirtualRouterEngine } from '../../dist/router/virtual-router/engine.js';
import { bootstrapVirtualRouterConfig } from '../../dist/router/virtual-router/bootstrap.js';
import { VirtualRouterErrorCode } from '../../dist/router/virtual-router/types.js';

function createRequest(content) {
  return {
    model: 'gpt-5.2',
    messages: [{ role: 'user', content }],
    parameters: {},
    metadata: { originalEndpoint: '/v1/chat/completions' }
  };
}

function createMetadata(requestId, sessionId) {
  return {
    requestId,
    ...(sessionId ? { sessionId } : {}),
    entryEndpoint: '/v1/chat/completions',
    processMode: 'chat',
    stream: false,
    direction: 'request'
  };
}

console.log('🧪 virtual-router pool mode tests...');

// Allow dynamic availability toggles without touching health internals.
const blocked = new Set();
const penalties = new Map();
const errorMeta = new Map();
const quotaView = (providerKey) => ({
  inPool: !blocked.has(providerKey),
  selectionPenalty: penalties.get(providerKey) ?? 0,
  ...(errorMeta.get(providerKey) ?? {})
});

// 1) priority mode: rotate within the top tier, fallback when unavailable, then re-enter on recovery.
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
  const engine = new VirtualRouterEngine({ quotaView });
  engine.initialize(config);

  const r1 = engine.route(createRequest('hello'), createMetadata('req_priority_1'));
  assert.equal(r1.target.providerKey, 'tab.key1.gpt-5.2', 'priority mode should start with the first candidate');

  const r2 = engine.route(createRequest('hello2'), createMetadata('req_priority_2'));
  assert.equal(
    r2.target.providerKey,
    'tab.key2.gpt-5.2',
    'priority mode should rotate within the selected group when multiple keys are available'
  );

  blocked.add('tab.key1.gpt-5.2');
  const r3 = engine.route(createRequest('hello3'), createMetadata('req_priority_3'));
  assert.equal(r3.target.providerKey, 'tab.key2.gpt-5.2', 'priority mode should fallback when key becomes unavailable');

  blocked.delete('tab.key1.gpt-5.2');
  const r4 = engine.route(createRequest('hello4'), createMetadata('req_priority_4')).target.providerKey;
  const r5 = engine.route(createRequest('hello5'), createMetadata('req_priority_5')).target.providerKey;
  assert.ok(
    r4 === 'tab.key1.gpt-5.2' || r5 === 'tab.key1.gpt-5.2',
    'priority mode should re-include recovered key quickly'
  );
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
  const engine = new VirtualRouterEngine({ quotaView });
  engine.initialize(config);

  const sessionId = 'sticky_session';
  const a = engine.route(createRequest('a'), createMetadata('req_rr_1', sessionId)).target.providerKey;
  const b = engine.route(createRequest('b'), createMetadata('req_rr_2', sessionId)).target.providerKey;
  const c = engine.route(createRequest('c'), createMetadata('req_rr_3', sessionId)).target.providerKey;
  assert.equal(a, 'tab.key1.gpt-5.2');
  assert.equal(b, 'tab.key2.gpt-5.2');
  assert.equal(c, 'tab.key1.gpt-5.2');
}

// 3) single-provider route: must fail fast when quotaView blocks the only candidate.
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
  const engine = new VirtualRouterEngine({ quotaView });
  engine.initialize(config);

  blocked.add('tab.key1.gpt-5.2');
  let threw = false;
  try {
    engine.route(createRequest('blocked'), createMetadata('req_single_blocked'));
  } catch (err) {
    threw = true;
    assert.equal(err?.code, VirtualRouterErrorCode.PROVIDER_NOT_AVAILABLE);
  }
  assert.equal(threw, true, 'single-provider route should throw when quota blocks the only candidate');
  blocked.delete('tab.key1.gpt-5.2');
}

// 4) default route: must not bypass quota gating when all candidates are blocked.
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
  const engine = new VirtualRouterEngine({ quotaView });
  engine.initialize(config);

  blocked.add('tab.key1.gpt-5.2');
  blocked.add('tab.key2.gpt-5.2');
  let threw = false;
  try {
    engine.route(createRequest('blocked_all'), createMetadata('req_all_blocked'));
  } catch (err) {
    threw = true;
    assert.equal(err?.code, VirtualRouterErrorCode.PROVIDER_NOT_AVAILABLE);
  }
  assert.equal(threw, true, 'default route should throw when all candidates are quota-blocked');
  blocked.delete('tab.key1.gpt-5.2');
  blocked.delete('tab.key2.gpt-5.2');
}

// 4) penalty-aware selection: unhealthy candidates still get selected, but less frequently; recovery attempts pick the healthiest.
{
  const originalNow = Date.now;
  const halfLifeMs = 10 * 60 * 1000;
  const t0 = 1_700_000_000_000;
  Date.now = () => t0;

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
              key2: { value: 'dummy2' },
              key3: { value: 'dummy3' }
            }
          }
        }
      },
      routing: {
        default: [
          {
            id: 'default:penalty',
            priority: 100,
            mode: 'round-robin',
            targets: ['tab.key1.gpt-5.2', 'tab.key2.gpt-5.2', 'tab.key3.gpt-5.2']
          }
        ]
      },
      loadBalancing: {
        strategy: 'round-robin',
        healthWeighted: {
          enabled: true,
          baseWeight: 100,
          minMultiplier: 0.5,
          beta: 0.1,
          halfLifeMs,
          recoverToBestOnRetry: true
        }
      },
      classifier: {}
    }
  };

  const { config } = bootstrapVirtualRouterConfig(input);
  const engine = new VirtualRouterEngine({ quotaView });
  engine.initialize(config);

  errorMeta.set('tab.key1.gpt-5.2', { lastErrorAtMs: null, consecutiveErrorCount: 0 });
  errorMeta.set('tab.key2.gpt-5.2', { lastErrorAtMs: null, consecutiveErrorCount: 0 });
  // consecutiveErrorCount=5 at t0 => m = 1 - 0.1 * 5 = 0.5 (floor), so weights 100/100/50.
  errorMeta.set('tab.key3.gpt-5.2', { lastErrorAtMs: t0, consecutiveErrorCount: 5 });

  const counts = new Map([
    ['tab.key1.gpt-5.2', 0],
    ['tab.key2.gpt-5.2', 0],
    ['tab.key3.gpt-5.2', 0]
  ]);
  for (let i = 0; i < 250; i += 1) {
    const key = engine.route(createRequest(`p${i}`), createMetadata(`req_penalty_${i}`)).target.providerKey;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  assert.equal(counts.get('tab.key1.gpt-5.2'), 100, 'healthy key1 should keep high share under weights');
  assert.equal(counts.get('tab.key2.gpt-5.2'), 100, 'healthy key2 should keep high share under weights');
  assert.equal(counts.get('tab.key3.gpt-5.2'), 50, 'unhealthy key3 should still be selected, but less frequently');

  const retryReq = createRequest('retry');
  retryReq.metadata.excludedProviderKeys = ['tab.key3.gpt-5.2'];
  const recovered = engine.route(retryReq, createMetadata('req_penalty_retry')).target.providerKey;
  assert.equal(recovered, 'tab.key1.gpt-5.2', 'recovery attempt should pick the healthiest candidate first');

  // Time recovery: after 2 half-lives, decay=0.25 => effectiveErrors=1.25 => m=0.875 => weight=88.
  Date.now = () => t0 + halfLifeMs * 2;
  const { config: cfg2 } = bootstrapVirtualRouterConfig(input);
  const engine2 = new VirtualRouterEngine({ quotaView });
  engine2.initialize(cfg2);
  const counts2 = new Map([
    ['tab.key1.gpt-5.2', 0],
    ['tab.key2.gpt-5.2', 0],
    ['tab.key3.gpt-5.2', 0]
  ]);
  for (let i = 0; i < 288; i += 1) {
    const key = engine2.route(createRequest(`r${i}`), createMetadata(`req_recover_${i}`)).target.providerKey;
    counts2.set(key, (counts2.get(key) ?? 0) + 1);
  }
  assert.equal(counts2.get('tab.key3.gpt-5.2'), 88, 'degraded key should gradually recover share over time without errors');

  Date.now = originalNow;
}

// 5) antigravity sticky-by-model: do not rotate across keys until the current key is blocked.
{
  const input = {
    virtualrouter: {
      providers: {
        antigravity: {
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
            id: 'default:ag-sticky',
            priority: 100,
            mode: 'round-robin',
            targets: ['antigravity.key1.gpt-5.2', 'antigravity.key2.gpt-5.2']
          }
        ]
      },
      classifier: {}
    }
  };

  const { config } = bootstrapVirtualRouterConfig(input);
  const engine = new VirtualRouterEngine({ quotaView });
  engine.initialize(config);

  const a1 = engine.route(createRequest('x1'), createMetadata('req_ag_1')).target.providerKey;
  const a2 = engine.route(createRequest('x2'), createMetadata('req_ag_2')).target.providerKey;
  const a3 = engine.route(createRequest('x3'), createMetadata('req_ag_3')).target.providerKey;
  assert.equal(a1, 'antigravity.key1.gpt-5.2');
  assert.equal(a2, 'antigravity.key1.gpt-5.2');
  assert.equal(a3, 'antigravity.key1.gpt-5.2');

  blocked.add('antigravity.key1.gpt-5.2');
  const b1 = engine.route(createRequest('y1'), createMetadata('req_ag_4')).target.providerKey;
  assert.equal(b1, 'antigravity.key2.gpt-5.2');

  blocked.delete('antigravity.key1.gpt-5.2');
  const b2 = engine.route(createRequest('y2'), createMetadata('req_ag_5')).target.providerKey;
  assert.equal(b2, 'antigravity.key1.gpt-5.2', 'should re-prefer the primary key once it recovers');
}


// 6) weighted pool selection must balance by provider.model group, not by runtime-key count.
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
  const engine = new VirtualRouterEngine({ quotaView });
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

// 7) priority pools must stay inside the first available provider.model group instead of crossing groups by key count.
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
  const engine = new VirtualRouterEngine({ quotaView });
  engine.initialize(config);

  const p1 = engine.route(createRequest('prio1'), createMetadata('req_priority_group_1')).target.providerKey;
  const p2 = engine.route(createRequest('prio2'), createMetadata('req_priority_group_2')).target.providerKey;
  const p3 = engine.route(createRequest('prio3'), createMetadata('req_priority_group_3')).target.providerKey;
  assert.equal(p1, 'ag.key1.claude-sonnet-4-6-thinking');
  assert.equal(p2, 'ag.key2.claude-sonnet-4-6-thinking');
  assert.equal(p3, 'ag.key1.claude-sonnet-4-6-thinking');

  blocked.add('ag.key1.claude-sonnet-4-6-thinking');
  blocked.add('ag.key2.claude-sonnet-4-6-thinking');
  const fallback = engine.route(createRequest('prio4'), createMetadata('req_priority_group_4')).target.providerKey;
  assert.equal(fallback, 'tab.key1.glm-5', 'priority pools should only move to the next provider.model group after the first one is unavailable');
  blocked.delete('ag.key1.claude-sonnet-4-6-thinking');
  blocked.delete('ag.key2.claude-sonnet-4-6-thinking');
}

console.log('✅ virtual-router pool mode tests passed');
