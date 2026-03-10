#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const moduleUrl = pathToFileURL(
  path.join(repoRoot, 'dist', 'router', 'virtual-router', 'engine-selection', 'tier-selection-select.js')
).href;
const quotaModuleUrl = pathToFileURL(
  path.join(repoRoot, 'dist', 'router', 'virtual-router', 'engine-selection', 'tier-selection-quota-integration.js')
).href;

const baseHealthCfg = {
  enabled: false,
  baseWeight: 100,
  minMultiplier: 0.5,
  beta: 0.1,
  halfLifeMs: 10 * 60 * 1000,
  recoverToBestOnRetry: true
};

const baseContextCfg = {
  enabled: false,
  clientCapTokens: 200_000,
  gamma: 1,
  maxMultiplier: 2
};

const baselineNativeQuotaModule = `
exports.parseProviderKeyJson = (providerKey) => {
  const raw = String(providerKey || '').trim();
  if (!raw) {
    return JSON.stringify({ providerId: null, alias: null });
  }
  const parts = raw.split('.');
  const providerId = parts[0] || null;
  const alias = parts.length >= 2 ? (parts[1] || null) : null;
  const keyIndexMatch = alias && /^([0-9]+)-/.exec(alias);
  const payload = { providerId, alias };
  if (keyIndexMatch && keyIndexMatch[1]) {
    payload.keyIndex = Number(keyIndexMatch[1]);
  }
  return JSON.stringify(payload);
};

exports.computeQuotaBucketsJson = (entriesJson, nowMs) => {
  const rows = JSON.parse(entriesJson || '[]');
  const buckets = new Map();

  function push(priority, entry) {
    const list = buckets.get(priority) || [];
    list.push(entry);
    buckets.set(priority, list);
  }

  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const key = typeof row.key === 'string' ? row.key : '';
    if (!key) continue;
    const order = Number.isFinite(row.order) ? row.order : 0;
    if (!row.hasQuota) {
      push(100, { key, penalty: 0, order });
      continue;
    }
    if (!row.inPool) continue;
    if (typeof row.cooldownUntil === 'number' && row.cooldownUntil > nowMs) continue;
    if (typeof row.blacklistUntil === 'number' && row.blacklistUntil > nowMs) continue;
    const priority = Number.isFinite(row.priorityTier) ? row.priorityTier : 100;
    const penalty = Number.isFinite(row.selectionPenalty) && row.selectionPenalty > 0 ? Math.floor(row.selectionPenalty) : 0;
    push(priority, { key, penalty, order });
  }

  const priorities = Array.from(buckets.keys()).sort((a, b) => a - b);
  const leadingEmptyPriority = priorities.length ? priorities[0] - 1 : 0;
  const emittedPriorities = priorities.includes(leadingEmptyPriority)
    ? priorities
    : [leadingEmptyPriority, ...priorities];
  const payload = {
    priorities: emittedPriorities,
    buckets: priorities.map((priority) => ({
      priority,
      entries: buckets.get(priority) || []
    }))
  };
  return JSON.stringify(payload);
};
`;

async function importFresh(tag) {
  return import(`${moduleUrl}?case=${tag}_${Date.now()}_${Math.random().toString(16).slice(2)}`);
}

async function importQuotaFresh(tag) {
  return import(`${quotaModuleUrl}?case=${tag}_${Date.now()}_${Math.random().toString(16).slice(2)}`);
}

function setEnvVar(name, value) {
  if (value === undefined || value === null || value === '') {
    delete process.env[name];
  } else {
    process.env[name] = String(value);
  }
}

function clearNativeEnv() {
  for (const key of [
    'ROUTECODEX_LLMS_ROUTER_NATIVE_PATH',
    'RCC_LLMS_ROUTER_NATIVE_PATH',
    'ROUTECODEX_LLMS_ROUTER_NATIVE_DISABLE',
    'RCC_LLMS_ROUTER_NATIVE_DISABLE',
    'ROUTECODEX_LLMS_ROUTER_NATIVE_REQUIRE',
    'RCC_LLMS_ROUTER_NATIVE_REQUIRE'
  ]) {
    delete process.env[key];
  }
}

async function withTempNativeModule(content, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'llms-tier-selection-native-'));
  const file = path.join(dir, 'mock-native.cjs');
  await fs.writeFile(file, content, 'utf8');
  try {
    await fn(file);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function modelFromKey(key) {
  const parts = String(key || '').split('.');
  if (parts.length >= 3) return parts.slice(2).join('.');
  if (parts.length === 2) return parts[1] || '';
  return '';
}

function createProviderRegistry(opts = {}) {
  const throwKeys = new Set(Array.isArray(opts.throwKeys) ? opts.throwKeys : []);
  const modelByKey = opts.modelByKey || {};
  return {
    get(key) {
      if (throwKeys.has(key)) {
        throw new Error(`provider-registry boom for ${key}`);
      }
      return { modelId: modelByKey[key] || modelFromKey(key) };
    }
  };
}

function createDeps(opts = {}) {
  const availableByKey = new Map(Object.entries(opts.availableByKey || {}));
  const quotaByKey = opts.quotaByKey ? new Map(Object.entries(opts.quotaByKey)) : null;
  const selectCalls = [];
  const aliasQueueStore = opts.aliasQueueStore;

  const deps = {
    routing: {},
    providerRegistry: opts.providerRegistry || createProviderRegistry({ throwKeys: opts.registryThrowKeys }),
    healthManager: {
      isAvailable(key) {
        return availableByKey.has(key) ? Boolean(availableByKey.get(key)) : true;
      }
    },
    contextAdvisor: {},
    loadBalancer: {
      getPolicy() {
        return {
          strategy: opts.policyStrategy || 'round-robin',
          weights: opts.policyWeights,
          aliasSelection: opts.aliasSelection
        };
      },
      select(payload, mode) {
        selectCalls.push({ payload, mode, kind: 'select' });
        if (typeof opts.selectImpl === 'function') {
          return opts.selectImpl(payload, mode, selectCalls.length - 1);
        }
        for (const key of payload.candidates) {
          if (!payload.availabilityCheck || payload.availabilityCheck(key)) {
            return key;
          }
        }
        return null;
      },
      selectGrouped(payload, mode) {
        if (typeof opts.selectGroupedImpl === 'function') {
          selectCalls.push({ payload, mode, kind: 'selectGrouped' });
          return opts.selectGroupedImpl(payload, mode, selectCalls.length - 1);
        }
        return null;
      }
    },
    isProviderCoolingDown() {
      return false;
    },
    resolveStickyKey() {
      return undefined;
    }
  };

  if (quotaByKey) {
    deps.quotaView = (key) => (quotaByKey.has(key) ? quotaByKey.get(key) : null);
  }
  if (aliasQueueStore) {
    deps.aliasQueueStore = aliasQueueStore;
  }

  return { deps, selectCalls };
}

function baseInput(overrides = {}) {
  return {
    routeName: 'test-route',
    tier: {
      id: 'tier-1',
      targets: [],
      priority: 100,
      mode: 'round-robin'
    },
    stickyKey: 'sticky-key',
    candidates: [],
    isSafePool: false,
    deps: createDeps().deps,
    options: { allowAliasRotation: false },
    contextResult: { usage: {} },
    warnRatio: 0.9,
    excludedKeys: new Set(),
    isRecoveryAttempt: false,
    now: 1000,
    nowForWeights: 1000,
    healthWeightedCfg: baseHealthCfg,
    contextWeightedCfg: baseContextCfg,
    ...overrides
  };
}

async function main() {
  const baselineDir = await fs.mkdtemp(path.join(os.tmpdir(), 'llms-tier-selection-native-baseline-'));
  const baselinePath = path.join(baselineDir, 'mock-native.cjs');
  await fs.writeFile(baselinePath, baselineNativeQuotaModule, 'utf8');

  try {
    clearNativeEnv();
    setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', baselinePath);

  const mod = await importFresh('tier-selection');
  const select = mod.selectProviderKeyFromCandidatePool;
  const quotaMod = await importQuotaFresh('quota-direct');
  const selectQuota = quotaMod.selectProviderKeyWithQuotaBuckets;
  assert.equal(typeof select, 'function');
  assert.equal(typeof selectQuota, 'function');

  const makeQuotaInput = (overrides = {}) => {
    const now = 1000;
    return {
      routeName: 'quota-direct',
      tier: { id: 'tier-q', targets: [], priority: 1, mode: 'round-robin' },
      stickyKey: 'sticky-q',
      candidates: [],
      isSafePool: false,
      deps: createDeps().deps,
      options: { allowAliasRotation: false },
      contextResult: { usage: {} },
      warnRatio: 0.9,
      excludedKeys: new Set(),
      isRecoveryAttempt: false,
      now,
      nowForWeights: now,
      healthWeightedCfg: baseHealthCfg,
      contextWeightedCfg: baseContextCfg,
      tierLoadBalancing: { strategy: undefined, weights: undefined },
      quotaView: () => null,
      isAvailable: () => true,
      selectFirstAvailable: (keys) => keys.find(() => true) ?? null,
      applyAliasStickyQueuePinning: (keys) => keys,
      preferAntigravityAliasesOnRetry: (keys) => keys,
      ...overrides
    };
  };

  {
    const now = 20_000;
    const { deps, selectCalls } = createDeps({
      quotaByKey: {
        'qp.a1': { inPool: true, priorityTier: 1, selectionPenalty: 2, lastErrorAtMs: now - 200, consecutiveErrorCount: 3 },
        'qp.a2': { inPool: true, priorityTier: 1, selectionPenalty: 0 },
        'qp.b1': { inPool: true, priorityTier: 2, selectionPenalty: 1, lastErrorAtMs: now - 300, consecutiveErrorCount: 2 },
        'qp.b2': { inPool: true, priorityTier: 2, selectionPenalty: 'bad' },
        'qp.cooldown': { inPool: true, priorityTier: 1, cooldownUntil: now + 1000 },
        'qp.blacklist': { inPool: true, priorityTier: 1, blacklistUntil: now + 1000 },
        'qp.noquota': null,
        'qp.badPriority': { inPool: true, priorityTier: 'bad' }
      },
      selectImpl(payload, mode, index) {
        assert.equal(mode, 'round-robin');
        payload.availabilityCheck('qp.cooldown');
        payload.availabilityCheck('qp.blacklist');
        payload.availabilityCheck('qp.noquota');
        payload.availabilityCheck('missing-provider-key');
        if (index === 0) return null;
        return payload.candidates[0] || null;
      }
    });

    const selected = select(
      baseInput({
        deps,
        now,
        nowForWeights: now,
        candidates: ['qp.a1', 'qp.a2', 'qp.b1', 'qp.b2', 'qp.cooldown', 'qp.blacklist', 'qp.noquota', 'qp.badPriority'],
        tier: {
          id: 'quota-priority',
          targets: ['qp.a1', 'qp.a2', 'qp.b1', 'qp.b2'],
          priority: 1,
          mode: 'priority'
        },
        isSafePool: true,
        healthWeightedCfg: { ...baseHealthCfg, enabled: true },
        contextWeightedCfg: { ...baseContextCfg, enabled: true },
        contextResult: {
          usage: {
            'qp.a1': { limit: 8000 },
            'qp.a2': { limit: 12000 },
            'qp.b1': { limit: 24000 },
            'qp.b2': { limit: 36000 }
          }
        }
      })
    );
    assert.equal(selected, 'qp.b1');
    assert.equal(selectCalls.length, 2);
    assert.ok((selectCalls[1]?.payload.weights?.['qp.b1'] || 0) >= 1);
  }

  {
    const { deps } = createDeps({
      quotaByKey: {
        'q.unknown.a': { inPool: true, priorityTier: 1 },
        'q.unknown.b': { inPool: true, priorityTier: 1 }
      }
    });
    const selected = select(
      baseInput({
        deps,
        candidates: ['q.unknown.a', 'q.unknown.b'],
        tier: { id: 'quota-priority-group-null', targets: [], priority: 1, mode: 'priority' }
      })
    );
    assert.equal(selected, null);
  }

  {
    const { deps, selectCalls } = createDeps({
      policyStrategy: 'round-robin',
      policyWeights: { 'pool.global.a': 99, 'pool.global.b': 1 },
      providerRegistry: createProviderRegistry({
        modelByKey: {
          'poola.key1.model-a': 'model-a',
          'poolb.key1.model-b': 'model-b'
        }
      }),
      selectImpl(payload, mode) {
        assert.equal(mode, 'weighted');
        assert.deepEqual(payload.weights, {
          'poola.key1.model-a': 5,
          'poolb.key1.model-b': 1
        });
        return 'poola.key1.model-a';
      }
    });
    const selected = select(
      baseInput({
        deps,
        candidates: ['poola.key1.model-a', 'poolb.key1.model-b'],
        tier: {
          id: 'pool-local-weighted',
          targets: ['poola.key1.model-a', 'poolb.key1.model-b'],
          priority: 1,
          loadBalancing: {
            strategy: 'weighted',
            weights: {
              'poola.model-a': 5,
              'poolb.model-b': 1
            }
          }
        }
      })
    );
    assert.equal(selected, 'poola.key1.model-a');
    assert.equal(selectCalls[0]?.mode, 'weighted');
  }

  {
    const { deps, selectCalls } = createDeps({
      policyStrategy: 'round-robin',
      providerRegistry: createProviderRegistry({
        modelByKey: {
          'quota.key1.model-a': 'model-a',
          'quota.key1.model-b': 'model-b'
        }
      }),
      quotaByKey: {
        'quota.key1.model-a': { inPool: true, priorityTier: 1, selectionPenalty: 0 },
        'quota.key1.model-b': { inPool: true, priorityTier: 1, selectionPenalty: 1 }
      },
      selectImpl(payload, mode) {
        assert.equal(mode, 'weighted');
        assert.equal(payload.weights?.['quota.key1.model-a'], 100);
        assert.equal(payload.weights?.['quota.key1.model-b'], 150);
        return 'quota.key1.model-b';
      }
    });
    const selected = select(
      baseInput({
        deps,
        candidates: ['quota.key1.model-a', 'quota.key1.model-b'],
        tier: {
          id: 'pool-quota-weighted',
          targets: ['quota.key1.model-a', 'quota.key1.model-b'],
          priority: 1,
          loadBalancing: {
            strategy: 'weighted',
            weights: {
              'quota.model-a': 1,
              'quota.model-b': 3
            }
          }
        }
      })
    );
    assert.equal(selected, 'quota.key1.model-b');
    assert.equal(selectCalls[0]?.mode, 'weighted');
  }

  {
    const { deps } = createDeps({
      quotaByKey: {
        'q.priority.a': { inPool: true, priorityTier: 1 },
        'q.priority.b': { inPool: true, priorityTier: 1 }
      }
    });
    const selected = select(
      baseInput({
        deps,
        candidates: ['q.priority.a', 'q.priority.b'],
        tier: { id: 'quota-priority-recovery', targets: ['q.priority.a', 'q.priority.b'], priority: 1, mode: 'priority' },
        isRecoveryAttempt: true
      })
    );
    assert.equal(selected, 'q.priority.a');
  }

  {
    const { deps, selectCalls } = createDeps({
      quotaByKey: {
        'q.rr.a': { inPool: true, priorityTier: 1, selectionPenalty: 4 },
        'q.rr.b': { inPool: true, priorityTier: 1, selectionPenalty: 1 }
      },
      selectImpl(payload, mode) {
        assert.equal(mode, 'round-robin');
        return payload.candidates[0] || null;
      }
    });
    const selected = select(
      baseInput({
        deps,
        candidates: ['q.rr.a', 'q.rr.b'],
        tier: { id: 'quota-round-robin', targets: ['q.rr.a', 'q.rr.b'], priority: 1, mode: 'round-robin' },
        isSafePool: true,
        contextWeightedCfg: { ...baseContextCfg, enabled: true },
        contextResult: {
          usage: {
            'q.rr.a': { limit: 3000 },
            'q.rr.b': { limit: 12000 }
          }
        }
      })
    );
    assert.equal(selected, 'q.rr.a');
    assert.ok((selectCalls[0]?.payload.weights?.['q.rr.a'] || 0) >= 1);
  }

  await withTempNativeModule(
    `exports.parseProviderKeyJson = (providerKey) => {
      const raw = String(providerKey || '').trim();
      if (!raw) return JSON.stringify({ providerId: null, alias: null });
      const parts = raw.split('.');
      return JSON.stringify({ providerId: parts[0] || null, alias: parts[1] || null });
    };
    exports.computeQuotaBucketsJson = () => JSON.stringify({
      priorities: [0, 1],
      buckets: [
        {
          priority: 1,
          entries: [
            { key: "native.bad.a", penalty: 0, order: 0 },
            { key: "native.bad.b", penalty: 0, order: 1 }
          ]
        }
      ]
    });`,
    async (modulePath) => {
      setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
      setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_DISABLE', '');

      {
        const { deps } = createDeps({
          quotaByKey: {
            'native.bad.a': { inPool: true, priorityTier: 1 },
            'native.bad.b': { inPool: true, priorityTier: 1 }
          }
        });
        const selected = select(
          baseInput({
            deps,
            candidates: ['native.bad.a', 'native.bad.b'],
            tier: { id: 'native-empty-bucket-continue', targets: ['native.bad.a', 'native.bad.b'], priority: 1, mode: 'round-robin' }
          })
        );
        assert.equal(selected, 'native.bad.a');
      }

      {
        const { deps } = createDeps({
          quotaByKey: {
            'native.bad.a': { inPool: false, priorityTier: 1 },
            'native.bad.b': { inPool: false, priorityTier: 1 }
          }
        });
        const selected = select(
          baseInput({
            deps,
            candidates: ['native.bad.a', 'native.bad.b'],
            tier: { id: 'native-priority-recovery-null', targets: ['native.bad.a', 'native.bad.b'], priority: 1, mode: 'priority' },
            isRecoveryAttempt: true
          })
        );
        assert.equal(selected, null);
      }

      {
        const { deps } = createDeps({
          quotaByKey: {
            'native.bad.a': { inPool: false, priorityTier: 1 },
            'native.bad.b': { inPool: false, priorityTier: 1 }
          }
        });
        const selected = select(
          baseInput({
            deps,
            candidates: ['native.bad.a', 'native.bad.b'],
            tier: { id: 'native-round-robin-recovery-null', targets: ['native.bad.a', 'native.bad.b'], priority: 1, mode: 'round-robin' },
            isRecoveryAttempt: true
          })
        );
        assert.equal(selected, null);
      }
    }
  );
  setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', baselinePath);
  setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_DISABLE', '');

  {
    const selected = selectQuota(
      makeQuotaInput({
        candidates: [undefined],
        quotaView: () => null,
        tier: { id: 'quota-undefined-key', targets: [], priority: 1, mode: 'round-robin' }
      })
    );
    assert.equal(selected, null);
  }

  {
    const { deps } = createDeps();
    const quotaMap = {
      'q.ctx.a': { inPool: true, priorityTier: 1, selectionPenalty: 2 },
      'q.ctx.b': { inPool: true, priorityTier: 1, selectionPenalty: 1 }
    };
    const selected = selectQuota(
      makeQuotaInput({
        deps,
        candidates: ['q.ctx.a', 'q.ctx.b'],
        tier: { id: 'quota-context-fallback-weight', targets: ['ghost.ctx.model', 'q.ctx.a', 'q.ctx.b'], priority: 1, mode: 'priority' },
        isSafePool: true,
        contextWeightedCfg: { ...baseContextCfg, enabled: true },
        contextResult: { usage: { 'q.ctx.a': { limit: 2000 }, 'q.ctx.b': { limit: 8000 } } },
        quotaView: (key) => quotaMap[key] || null,
        applyAliasStickyQueuePinning: () => ['ghost.ctx.model', 'q.ctx.a', 'q.ctx.b'],
        isAvailable: () => true
      })
    );
    assert.equal(selected, 'ghost.ctx.model');
  }

  {
    const { deps } = createDeps();
    const quotaMap = {
      'q.group.a': { inPool: true, priorityTier: 1, selectionPenalty: 3 },
      'q.group.b': { inPool: true, priorityTier: 1, selectionPenalty: 0 }
    };
    const selected = selectQuota(
      makeQuotaInput({
        deps,
        candidates: ['q.group.a', 'q.group.b'],
        tier: { id: 'quota-group-fallback-weight', targets: ['ghost.group.model', 'q.group.a', 'q.group.b'], priority: 1, mode: 'priority' },
        options: { allowAliasRotation: true },
        quotaView: (key) => quotaMap[key] || null,
        applyAliasStickyQueuePinning: () => ['ghost.group.model', 'q.group.a', 'q.group.b'],
        isAvailable: () => true
      })
    );
    assert.equal(selected, 'ghost.group.model');
  }

  {
    const { deps, selectCalls } = createDeps();
    const quotaMap = {
      'q.rr.a': { inPool: true, priorityTier: 1, selectionPenalty: 2 },
      'q.rr.b': { inPool: true, priorityTier: 1, selectionPenalty: 1 }
    };
    const selected = selectQuota(
      makeQuotaInput({
        deps,
        candidates: ['q.rr.a', 'q.rr.b'],
        tier: { id: 'quota-rr-undefined-mode', targets: ['q.rr.a', 'q.rr.b'], priority: 1, mode: undefined },
        options: { allowAliasRotation: true },
        quotaView: (key) => quotaMap[key] || null
      })
    );
    assert.equal(selected, 'q.rr.a');
    assert.equal(selectCalls[0]?.mode, undefined);
    assert.equal(selectCalls[0]?.payload.stickyKey, undefined);
  }

  {
    const selected = selectQuota(
      makeQuotaInput({
        candidates: ['q.single.return'],
        tier: { id: 'quota-single-candidate-return', targets: ['q.single.return'], priority: 1, mode: 'round-robin' },
        quotaView: (key) => (key === 'q.single.return' ? { inPool: true, priorityTier: 1, selectionPenalty: 0 } : null)
      })
    );
    assert.equal(selected, 'q.single.return');
  }

  {
    const selected = selectQuota(
      makeQuotaInput({
        candidates: ['q.pr.continue.a', 'q.pr.continue.b', 'q.pr.continue.c', 'q.pr.continue.d'],
        tier: {
          id: 'quota-priority-recovery-continue',
          targets: ['q.pr.continue.a', 'q.pr.continue.b', 'q.pr.continue.c', 'q.pr.continue.d'],
          priority: 1,
          mode: 'priority'
        },
        isRecoveryAttempt: true,
        selectFirstAvailable: () => null,
        quotaView: (key) => {
          if (key === 'q.pr.continue.a' || key === 'q.pr.continue.b') {
            return { inPool: true, priorityTier: 1, selectionPenalty: 1 };
          }
          if (key === 'q.pr.continue.c' || key === 'q.pr.continue.d') {
            return { inPool: true, priorityTier: 2, selectionPenalty: 1 };
          }
          return null;
        }
      })
    );
    assert.equal(selected, null);
  }

  {
    const selected = selectQuota(
      makeQuotaInput({
        candidates: ['q.rr.continue.a', 'q.rr.continue.b'],
        tier: {
          id: 'quota-round-robin-recovery-continue',
          targets: ['q.rr.continue.a', 'q.rr.continue.b'],
          priority: 1,
          mode: 'round-robin'
        },
        isRecoveryAttempt: true,
        selectFirstAvailable: () => null,
        quotaView: (key) =>
          key === 'q.rr.continue.a' || key === 'q.rr.continue.b'
            ? { inPool: true, priorityTier: 1, selectionPenalty: 1 }
            : null
      })
    );
    assert.equal(selected, null);
  }

  clearNativeEnv();
  console.log('✅ coverage-virtual-router-tier-selection passed');
  } finally {
    await fs.rm(baselineDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  clearNativeEnv();
  console.error('❌ coverage-virtual-router-tier-selection failed:', error);
  process.exit(1);
});
