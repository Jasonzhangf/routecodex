#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const moduleUrl = pathToFileURL(
  path.join(
    repoRoot,
    'dist',
    'router',
    'virtual-router',
    'engine-selection',
    'tier-selection-antigravity-session-lease.js'
  )
).href;
const reqOutboundNativeUrl = pathToFileURL(
  path.join(
    repoRoot,
    'dist',
    'router',
    'virtual-router',
    'engine-selection',
    'native-hub-pipeline-req-outbound-semantics.js'
  )
).href;
const hotpathNativeUrl = pathToFileURL(
  path.join(
    repoRoot,
    'dist',
    'router',
    'virtual-router',
    'engine-selection',
    'native-router-hotpath.js'
  )
).href;

async function importFresh(tag) {
  return import(`${moduleUrl}?case=${tag}_${Date.now()}_${Math.random().toString(16).slice(2)}`);
}

async function importReqOutboundNativeFresh(tag) {
  return import(`${reqOutboundNativeUrl}?case=${tag}_${Date.now()}_${Math.random().toString(16).slice(2)}`);
}

async function importHotpathNativeFresh(tag) {
  return import(`${hotpathNativeUrl}?case=${tag}_${Date.now()}_${Math.random().toString(16).slice(2)}`);
}

function seedPinnedAlias(runRespInboundStage3CompatWithNative, aliasKey, sessionId, signature, requestId) {
  runRespInboundStage3CompatWithNative({
    payload: {
      request_id: requestId,
      candidates: [
        {
          content: {
            parts: [{ thoughtSignature: signature }]
          }
        }
      ]
    },
    adapterContext: {
      providerProtocol: 'gemini-chat',
      requestId,
      providerId: 'antigravity',
      providerKey: `${aliasKey}.gemini-3-pro`,
      runtimeKey: aliasKey,
      sessionId
    },
    explicitProfile: 'chat:gemini-cli'
  });
}

function buildProviderRegistry(models) {
  const map = new Map(Object.entries(models));
  return {
    get(key) {
      const modelId = map.get(key) ?? '';
      return { modelId };
    }
  };
}

function buildDeps({
  models,
  policyBinding = 'soft',
  leaseStore = new Map(),
  sessionAliasStore = new Map(),
  quotaInPool
}) {
  return {
    providerRegistry: buildProviderRegistry(models),
    antigravityAliasLeaseStore: leaseStore,
    antigravitySessionAliasStore: sessionAliasStore,
    antigravityAliasReuseCooldownMs: 60_000,
    loadBalancer: {
      getPolicy() {
        return { aliasSelection: { antigravitySessionBinding: policyBinding } };
      }
    },
    quotaView: quotaInPool
      ? (key) => ({
          inPool: quotaInPool(key)
        })
      : undefined
  };
}

async function main() {
  const mod = await importFresh('tier-antigravity-session-lease');
  const reqOutboundNative = await importReqOutboundNativeFresh('tier-antigravity-session-lease');
  const hotpathNative = await importHotpathNativeFresh('tier-antigravity-session-lease');
  const applyAntigravityAliasSessionLeases = mod.applyAntigravityAliasSessionLeases;
  const isAntigravityGeminiModelKey = mod.isAntigravityGeminiModelKey;
  const extractLeaseRuntimeKey = mod.extractLeaseRuntimeKey;
  const runRespInboundStage3CompatWithNative = reqOutboundNative.runRespInboundStage3CompatWithNative;
  const lookupAntigravityPinnedAliasForSessionIdWithNative =
    hotpathNative.lookupAntigravityPinnedAliasForSessionIdWithNative;

  assert.equal(typeof applyAntigravityAliasSessionLeases, 'function');
  assert.equal(typeof isAntigravityGeminiModelKey, 'function');
  assert.equal(typeof extractLeaseRuntimeKey, 'function');

  {
    const deps = buildDeps({
      models: {
        'antigravity.aliasa.gemini-3-pro': 'gemini-3-pro',
        'antigravity.aliasb.claude-sonnet-4-5': 'claude-sonnet-4-5',
        'tab.key1.gpt-5': 'gpt-5'
      }
    });
    assert.equal(isAntigravityGeminiModelKey('tab.key1.gpt-5', deps), false);
    assert.equal(isAntigravityGeminiModelKey('antigravity.aliasb.claude-sonnet-4-5', deps), false);
    assert.equal(isAntigravityGeminiModelKey('antigravity.aliasa.gemini-3-pro', deps), true);
    assert.equal(isAntigravityGeminiModelKey('invalid-key', deps), false);
    assert.equal(isAntigravityGeminiModelKey('antigravity.extra.parts.model.id', deps), false);
    assert.equal(extractLeaseRuntimeKey(123, deps), null);
    assert.equal(extractLeaseRuntimeKey('', deps), null);
    assert.equal(extractLeaseRuntimeKey('antigravity.bad', deps), null);
    assert.equal(extractLeaseRuntimeKey('antigravity.', deps), null);
    assert.equal(extractLeaseRuntimeKey('tab.key1.gpt-5', deps), 'tab.key1');
    assert.equal(extractLeaseRuntimeKey('antigravity.aliasb.claude-sonnet-4-5', deps), null);
    assert.equal(extractLeaseRuntimeKey('antigravity.aliasa.gemini-3-pro', deps), 'antigravity.aliasa::gemini');
  }

  {
    const deps = buildDeps({
      models: {
        'antigravity.aliasa.gemini-3-pro': 'gemini-3-pro'
      }
    });
    assert.deepEqual(applyAntigravityAliasSessionLeases([], deps, {}), {
      targets: [],
      blocked: 0,
      preferredPinned: false,
      pinnedStrict: false
    });
  }

  {
    const deps = buildDeps({
      models: {
        'antigravity.aliasa.gemini-3-pro': 'gemini-3-pro'
      }
    });
    const out = applyAntigravityAliasSessionLeases(
      ['antigravity.aliasa.gemini-3-pro'],
      deps,
      { __rt: { disableAntigravitySessionBinding: true }, sessionId: 's1' }
    );
    assert.equal(out.targets.length, 1);
    assert.equal(out.blocked, 0);
  }

  {
    const deps = buildDeps({
      models: {
        'antigravity.aliasa.gemini-3-pro': 'gemini-3-pro'
      }
    });
    deps.antigravityAliasLeaseStore = undefined;
    deps.antigravitySessionAliasStore = undefined;
    const out = applyAntigravityAliasSessionLeases(
      ['antigravity.aliasa.gemini-3-pro'],
      deps,
      { sessionId: 's1' }
    );
    assert.equal(out.targets.length, 1);
  }

  {
    const deps = buildDeps({
      models: {
        'antigravity.aliasa.gemini-3-pro': 'gemini-3-pro'
      }
    });
    const targets = ['antigravity.aliasa.gemini-3-pro'];
    assert.equal(applyAntigravityAliasSessionLeases(targets, deps, null).targets.length, 1);
    assert.equal(applyAntigravityAliasSessionLeases(targets, deps, { anything: true }).targets.length, 1);
    assert.equal(
      applyAntigravityAliasSessionLeases(targets, deps, { __rt: { antigravitySessionBinding: false }, sessionId: 's1' })
        .targets.length,
      1
    );
    assert.equal(
      applyAntigravityAliasSessionLeases(targets, deps, { __rt: { antigravitySessionBinding: 'off' }, sessionId: 's1' })
        .targets.length,
      1
    );
    assert.equal(
      applyAntigravityAliasSessionLeases(targets, deps, { __rt: { antigravitySessionBinding: 'on' }, sessionId: 's1' })
        .targets.length,
      1
    );
  }

  {
    const leaseStore = new Map();
    const sessionAliasStore = new Map();
    const deps = buildDeps({
      models: {
        'antigravity.aliasa.gemini-3-pro': 'gemini-3-pro',
        'antigravity.aliasb.gemini-3-pro': 'gemini-3-pro',
        'tab.key1.gpt-5': 'gpt-5'
      },
      leaseStore,
      sessionAliasStore,
      policyBinding: 'strict'
    });
    seedPinnedAlias(
      runRespInboundStage3CompatWithNative,
      'antigravity.aliasa',
      'sid-pin',
      'x'.repeat(80),
      'req_seed_antigravity_aliasa_sid_pin'
    );
    const out = applyAntigravityAliasSessionLeases(
      ['antigravity.aliasa.gemini-3-pro', 'antigravity.aliasb.gemini-3-pro', 'tab.key1.gpt-5'],
      deps,
      { antigravitySessionId: 'sid-pin' }
    );
    assert.equal(out.pinnedStrict, true);
    assert.equal(out.preferredPinned, true);
    assert.ok(out.targets.includes('antigravity.aliasa.gemini-3-pro'));
    assert.ok(!out.targets.includes('antigravity.aliasb.gemini-3-pro'));
    assert.ok(out.targets.includes('tab.key1.gpt-5'));
  }

  {
    const leaseStore = new Map();
    const sessionAliasStore = new Map();
    sessionAliasStore.set('session:sid-unpin-force::gemini', 'antigravity.aliasc');
    const deps = buildDeps({
      models: {
        'antigravity.aliasc.gemini-3-pro': 'gemini-3-pro',
        'antigravity.aliasd.gemini-3-pro': 'gemini-3-pro'
      },
      leaseStore,
      sessionAliasStore,
      policyBinding: 'strict',
      quotaInPool: () => false
    });
    seedPinnedAlias(
      runRespInboundStage3CompatWithNative,
      'antigravity.aliasc',
      'sid-unpin-force',
      'm'.repeat(90),
      'req_seed_antigravity_aliasc_sid_unpin_force'
    );
    const oldLog = console.log;
    console.log = () => {
      throw new Error('expected-log-fail');
    };
    process.env.ROUTECODEX_STAGE_LOG = '1';
    try {
      const out = applyAntigravityAliasSessionLeases(
        ['antigravity.aliasc.gemini-3-pro', 'antigravity.aliasd.gemini-3-pro'],
        deps,
        { antigravitySessionId: 'sid-unpin-force' }
      );
      assert.ok(Array.isArray(out.targets));
      assert.equal(lookupAntigravityPinnedAliasForSessionIdWithNative('sid-unpin-force', { hydrate: false }), undefined);
    } finally {
      delete process.env.ROUTECODEX_STAGE_LOG;
      console.log = oldLog;
    }
  }

  {
    let modelReads = 0;
    const providerRegistry = {
      get(key) {
        modelReads += 1;
        const modelId = modelReads === 6 ? 'claude-sonnet-4-5' : 'gemini-3-pro';
        return { modelId, key };
      }
    };
    const deps = {
      providerRegistry,
      antigravityAliasLeaseStore: new Map(),
      antigravitySessionAliasStore: new Map(),
      antigravityAliasReuseCooldownMs: 60_000,
      loadBalancer: {
        getPolicy() {
          return { aliasSelection: { antigravitySessionBinding: 'strict' } };
        }
      },
      quotaView: undefined
    };
    seedPinnedAlias(
      runRespInboundStage3CompatWithNative,
      'antigravity.flip',
      'sid-flip',
      'f'.repeat(90),
      'req_seed_antigravity_flip_sid_flip'
    );
    const out = applyAntigravityAliasSessionLeases(['antigravity.flip.gemini-3-pro'], deps, {
      antigravitySessionId: 'sid-flip'
    });
    assert.ok(out.targets.includes('antigravity.flip.gemini-3-pro'));
  }

  {
    const leaseStore = new Map();
    const sessionAliasStore = new Map();
    const deps = buildDeps({
      models: {
        'antigravity.aliasa.gemini-3-pro': 'gemini-3-pro',
        'antigravity.aliasb.gemini-3-pro': 'gemini-3-pro'
      },
      leaseStore,
      sessionAliasStore
    });
    leaseStore.set('antigravity.aliasb::gemini', {
      sessionKey: 'session:other::gemini',
      lastSeenAt: Date.now()
    });
    const out = applyAntigravityAliasSessionLeases(
      ['antigravity.aliasa.gemini-3-pro', 'antigravity.aliasb.gemini-3-pro'],
      deps,
      { sessionId: 's-current' }
    );
    assert.equal(out.blocked, 1);
    assert.deepEqual(out.targets, ['antigravity.aliasa.gemini-3-pro']);
  }

  {
    const deps = buildDeps({
      models: {
        'antigravity.aliasa.gemini-3-pro': 'gemini-3-pro'
      }
    });
    deps.antigravityAliasReuseCooldownMs = Number.NaN;
    const out = applyAntigravityAliasSessionLeases(['antigravity.aliasa.gemini-3-pro'], deps, { sessionId: 's-cooldown' });
    assert.ok(Array.isArray(out.targets));
  }

  {
    const now = Date.now();
    const leaseStore = new Map();
    const sessionAliasStore = new Map();
    leaseStore.set('antigravity.same::gemini', {
      sessionKey: 'session:s-current::gemini',
      lastSeenAt: now
    });
    leaseStore.set('antigravity.stale::gemini', {
      sessionKey: 'session:other::gemini',
      lastSeenAt: now - 120_000
    });
    leaseStore.set('antigravity.busy::gemini', {
      sessionKey: 'session:other::gemini',
      lastSeenAt: now
    });
    const deps = buildDeps({
      models: {
        'antigravity.same.gemini-3-pro': 'gemini-3-pro',
        'antigravity.stale.gemini-3-pro': 'gemini-3-pro',
        'antigravity.busy.gemini-3-pro': 'gemini-3-pro',
        'antigravity.non.claude-sonnet-4-5': 'claude-sonnet-4-5',
        'antigravity..gemini-3-pro': 'gemini-3-pro',
        'tab.key1.gpt-5': 'gpt-5'
      },
      leaseStore,
      sessionAliasStore
    });
    const out = applyAntigravityAliasSessionLeases(
      [
        'antigravity.same.gemini-3-pro',
        'antigravity.stale.gemini-3-pro',
        'antigravity.busy.gemini-3-pro',
        'antigravity.non.claude-sonnet-4-5',
        'antigravity..gemini-3-pro',
        'tab.key1.gpt-5'
      ],
      deps,
      { sessionId: 's-current' }
    );
    assert.equal(out.blocked, 1);
    assert.ok(out.targets.includes('antigravity.same.gemini-3-pro'));
    assert.ok(out.targets.includes('antigravity.stale.gemini-3-pro'));
    assert.ok(!out.targets.includes('antigravity.busy.gemini-3-pro'));
    assert.ok(out.targets.includes('antigravity.non.claude-sonnet-4-5'));
    assert.ok(out.targets.includes('antigravity..gemini-3-pro'));
    assert.ok(out.targets.includes('tab.key1.gpt-5'));
  }

  {
    const leaseStore = new Map();
    const sessionAliasStore = new Map();
    sessionAliasStore.set('conversation:c1::gemini', 'antigravity.aliasb');
    leaseStore.set('antigravity.aliasb::gemini', {
      sessionKey: 'session:other::gemini',
      lastSeenAt: Date.now()
    });
    const deps = buildDeps({
      models: {
        'antigravity.aliasb.gemini-3-pro': 'gemini-3-pro'
      },
      leaseStore,
      sessionAliasStore
    });
    const out = applyAntigravityAliasSessionLeases(
      ['antigravity.aliasb.gemini-3-pro'],
      deps,
      { conversationId: 'c1' }
    );
    assert.equal(out.preferredRuntimeKey, undefined);
    assert.equal(out.targets.length, 0);
    assert.equal(out.blocked, 1);
  }

  {
    const leaseStore = new Map();
    const sessionAliasStore = new Map();
    sessionAliasStore.set('session:s-release::gemini', 'antigravity.aliasb');
    const deps = buildDeps({
      models: {
        'antigravity.aliasb.gemini-3-pro': 'gemini-3-pro'
      },
      leaseStore,
      sessionAliasStore,
      quotaInPool: () => false
    });
    const oldLog = console.log;
    console.log = () => {
      throw new Error('expected-log-fail');
    };
    process.env.ROUTECODEX_STAGE_LOG = '1';
    try {
      const out = applyAntigravityAliasSessionLeases(
        ['antigravity.aliasb.gemini-3-pro'],
        deps,
        { sessionId: 's-release' }
      );
      assert.equal(out.preferredRuntimeKey, undefined);
      assert.equal(sessionAliasStore.has('session:s-release::gemini'), false);
    } finally {
      delete process.env.ROUTECODEX_STAGE_LOG;
      console.log = oldLog;
    }
  }

  {
    const leaseStore = new Map();
    const sessionAliasStore = new Map();
    sessionAliasStore.set('session:s-release-rcc::gemini', 'antigravity.aliasb');
    const deps = buildDeps({
      models: {
        'antigravity.aliasb.gemini-3-pro': 'gemini-3-pro'
      },
      leaseStore,
      sessionAliasStore,
      quotaInPool: () => false
    });
    process.env.ROUTECODEX_STAGE_LOG = '';
    process.env.RCC_STAGE_LOG = '1';
    try {
      const out = applyAntigravityAliasSessionLeases(
        ['antigravity.aliasb.gemini-3-pro'],
        deps,
        { sessionId: 's-release-rcc' }
      );
      assert.equal(out.preferredRuntimeKey, undefined);
    } finally {
      delete process.env.ROUTECODEX_STAGE_LOG;
      delete process.env.RCC_STAGE_LOG;
    }
  }

  {
    const leaseStore = new Map();
    const sessionAliasStore = new Map();
    const deps = buildDeps({
      models: {
        'antigravity.aliasa.gemini-3-pro': 'gemini-3-pro',
        'antigravity.aliasb.gemini-3-pro': 'gemini-3-pro'
      },
      leaseStore,
      sessionAliasStore,
      policyBinding: 'strict',
      quotaInPool: () => false
    });
    seedPinnedAlias(
      runRespInboundStage3CompatWithNative,
      'antigravity.aliasa',
      'sid-unpin',
      'y'.repeat(90),
      'req_seed_antigravity_aliasa_sid_unpin'
    );
    process.env.RCC_STAGE_LOG = '1';
    const out = applyAntigravityAliasSessionLeases(
      ['antigravity.aliasa.gemini-3-pro', 'antigravity.aliasb.gemini-3-pro'],
      deps,
      { antigravitySessionId: 'sid-unpin' }
    );
    delete process.env.RCC_STAGE_LOG;
    assert.ok(Array.isArray(out.targets));
  }

  console.log('✅ coverage-virtual-router-tier-antigravity-session-lease passed');
}

main().catch((error) => {
  console.error('❌ coverage-virtual-router-tier-antigravity-session-lease failed:', error);
  process.exit(1);
});
