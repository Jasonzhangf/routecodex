import assert from 'node:assert/strict';
import { VirtualRouterEngine } from '../../dist/router/virtual-router/engine.js';
import { bootstrapVirtualRouterConfig } from '../../dist/router/virtual-router/bootstrap.js';

function createMemoryRoutingStateStore() {
  const store = new Map();
  return {
    loadSync(key) {
      return store.has(key) ? store.get(key) : null;
    },
    saveSync(key, value) {
      if (!key) return;
      if (value === null || value === undefined) {
        store.delete(key);
      } else {
        store.set(key, value);
      }
    },
    async saveAsync(key, value) {
      this.saveSync(key, value);
    }
  };
}

function createRequest(content) {
  return {
    model: 'gpt-5.2',
    messages: [{ role: 'user', content }],
    parameters: {},
    metadata: { originalEndpoint: '/v1/chat/completions' }
  };
}

function createMetadata(requestId) {
  return {
    requestId,
    entryEndpoint: '/v1/chat/completions',
    processMode: 'chat',
    stream: false,
    direction: 'request',
    routeHint: 'default'
  };
}

console.log('🧪 virtual-router quota vs health snapshot restore tests...');

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
          id: 'default:priority',
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
const quotaView = (providerKey) => ({ providerKey, inPool: true, priorityTier: 100 });

function mkHealthStore(reason) {
  const now = Date.now();
  const expiresAt = now + 60_000;
  return {
    loadInitialSnapshot() {
      return {
        providers: [
          {
            providerKey: 'tab.key1.gpt-5.2',
            state: 'tripped',
            failureCount: 3,
            cooldownExpiresAt: expiresAt,
            reason
          }
        ],
        cooldowns: [{ providerKey: 'tab.key1.gpt-5.2', cooldownExpiresAt: expiresAt }]
      };
    }
  };
}

// 1) quota mode must ignore non-policy cooldowns restored from health snapshots
// (quota-center owns 429/backoff/series cooldown decisions).
{
  const engine = new VirtualRouterEngine({
    quotaView,
    healthStore: mkHealthStore('rate_limit'),
    routingStateStore: createMemoryRoutingStateStore()
  });
  engine.initialize(config);
  const r = engine.route(createRequest('hello'), createMetadata('req_quota_health_restore_ignore'));
  assert.equal(
    r.target.providerKey,
    'tab.key1.gpt-5.2',
    'quota routing must not let legacy health snapshot cooldowns exclude candidates'
  );
}

// 2) quota mode must still restore explicit policy cooldowns (antigravity safety, etc.)
// In quota routing mode, health/cooldown must be driven by quotaView only, so even "policy-ish"
// health snapshot cooldowns must not exclude candidates.
{
  const engine = new VirtualRouterEngine({
    quotaView,
    healthStore: mkHealthStore('signature_missing'),
    routingStateStore: createMemoryRoutingStateStore()
  });
  engine.initialize(config);
  const r = engine.route(createRequest('hello'), createMetadata('req_quota_health_restore_policy'));
  assert.equal(
    r.target.providerKey,
    'tab.key1.gpt-5.2',
    'quota routing must ignore health snapshot cooldowns regardless of reason'
  );
}

console.log('✅ virtual-router quota vs health snapshot restore tests passed');
