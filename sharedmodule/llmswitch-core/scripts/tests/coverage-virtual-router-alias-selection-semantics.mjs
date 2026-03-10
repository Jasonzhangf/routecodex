#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const semanticsModuleUrl = pathToFileURL(
  path.join(
    repoRoot,
    'dist',
    'router',
    'virtual-router',
    'engine-selection',
    'native-virtual-router-alias-selection-semantics.js'
  )
).href;
const loaderSourcePath = path.join(
  repoRoot,
  'src',
  'router',
  'virtual-router',
  'engine-selection',
  'native-router-hotpath-loader.ts'
);

function cacheBustedImport(url, tag) {
  return import(`${url}?case=${tag}_${Date.now()}_${Math.random().toString(16).slice(2)}`);
}

async function importSemantics(tag) {
  return cacheBustedImport(semanticsModuleUrl, tag);
}

async function readRequiredNativeExports() {
  const source = await fs.readFile(loaderSourcePath, 'utf8');
  const block = source.match(/const REQUIRED_NATIVE_EXPORTS = \[(.*?)\] as const;/s);
  assert.ok(block && block[1], 'REQUIRED_NATIVE_EXPORTS block not found');
  const names = [...block[1].matchAll(/'([A-Za-z0-9_]+)'/g)].map((m) => String(m[1]));
  assert.ok(names.length > 0, 'no required native exports parsed');
  return names;
}

function buildMockNativeModuleContent(requiredNames, overrides = {}) {
  const lines = ['module.exports = {'];
  for (const name of requiredNames) {
    const impl = typeof overrides[name] === 'string'
      ? overrides[name]
      : 'function () { return "null"; }';
    lines.push(`  '${name}': ${impl},`);
  }
  lines.push('};');
  return lines.join('\n');
}

function setNativePath(modulePath) {
  if (!modulePath) {
    delete process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH;
    delete process.env.RCC_LLMS_ROUTER_NATIVE_PATH;
    return;
  }
  process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH = modulePath;
  delete process.env.RCC_LLMS_ROUTER_NATIVE_PATH;
}

function resolveNativeCandidatePaths() {
  return [
    path.join(repoRoot, 'rust-core', 'target', 'release', 'router_hotpath_napi.node'),
    path.join(repoRoot, 'rust-core', 'target', 'debug', 'router_hotpath_napi.node'),
    path.join(repoRoot, 'dist', 'native', 'router_hotpath_napi.node')
  ];
}

async function withNativeCandidatesHidden(run) {
  const renames = [];
  try {
    for (const original of resolveNativeCandidatePaths()) {
      try {
        await fs.access(original);
      } catch {
        continue;
      }
      const backup = `${original}.bak-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      await fs.rename(original, backup);
      renames.push({ original, backup });
    }
    await run();
  } finally {
    for (const entry of renames.reverse()) {
      await fs.rename(entry.backup, entry.original).catch(() => undefined);
    }
  }
}

async function withMockNative(requiredNames, overrides, run) {
  const prevRcc = process.env.RCC_LLMS_ROUTER_NATIVE_PATH;
  const prevRoute = process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rcc-alias-selection-native-'));
  const file = path.join(dir, 'mock-native.cjs');
  await fs.writeFile(file, buildMockNativeModuleContent(requiredNames, overrides), 'utf8');
  try {
    setNativePath(file);
    await run(file);
  } finally {
    if (prevRoute === undefined) {
      delete process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH;
    } else {
      process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH = prevRoute;
    }
    if (prevRcc === undefined) {
      delete process.env.RCC_LLMS_ROUTER_NATIVE_PATH;
    } else {
      process.env.RCC_LLMS_ROUTER_NATIVE_PATH = prevRcc;
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function runCoverage() {
  const requiredNames = await readRequiredNativeExports();

  const pinPayload = {
    queue: ['alpha', 'beta'],
    desiredOrder: ['alpha', 'beta'],
    excludedAliases: [],
    aliasBuckets: {
      alpha: ['antigravity.1-alpha.gemini-3-pro-high'],
      beta: ['antigravity.2-beta.gemini-3-pro-high']
    },
    candidateOrder: ['antigravity.1-alpha.gemini-3-pro-high', 'antigravity.2-beta.gemini-3-pro-high'],
    availabilityByAlias: { alpha: true, beta: true }
  };
  const pinFallback = {
    queue: ['alpha', 'beta'],
    selectedCandidates: ['antigravity.1-alpha.gemini-3-pro-high']
  };

  await withMockNative(
    requiredNames,
    {
      resolveAliasSelectionStrategyJson: 'function () { return JSON.stringify("sticky-queue"); }',
      pinAliasQueueJson: 'function () { return JSON.stringify({ queue: ["beta", "alpha"], selectedCandidates: ["antigravity.2-beta.gemini-3-pro-high"] }); }'
    },
    async () => {
      const mod = await importSemantics('success');
      assert.equal(
        mod.resolveAliasSelectionStrategyWithNative('antigravity', { enabled: true }, 'none'),
        'sticky-queue'
      );
      assert.deepEqual(mod.pinAliasQueueWithNative(pinPayload, pinFallback), {
        queue: ['beta', 'alpha'],
        selectedCandidates: ['antigravity.2-beta.gemini-3-pro-high']
      });
    }
  );

  await withMockNative(
    requiredNames,
    {
      resolveAliasSelectionStrategyJson: 'function (providerId) { return providerId === "" ? JSON.stringify("none") : JSON.stringify("sticky-queue"); }',
      pinAliasQueueJson: 'function () { return JSON.stringify({ queue: ["alpha", "beta"], selectedCandidates: ["antigravity.1-alpha.gemini-3-pro-high"] }); }'
    },
    async () => {
      const mod = await importSemantics('providerid-empty-cfg-undefined');
      assert.equal(
        mod.resolveAliasSelectionStrategyWithNative('', undefined, 'sticky-queue'),
        'none'
      );
    }
  );

  await withMockNative(
    requiredNames,
    {
      resolveAliasSelectionStrategyJson: 'function () { return JSON.stringify("none"); }',
      pinAliasQueueJson: 'function () { return JSON.stringify({ queue: ["alpha"], selectedCandidates: [] }); }'
    },
    async () => {
      const mod = await importSemantics('stringify-throws');
      const cycle = {};
      cycle.self = cycle;
      assert.throws(
        () => mod.resolveAliasSelectionStrategyWithNative('antigravity', cycle, 'sticky-queue'),
        /json stringify failed/
      );

      const payloadCycle = { ...pinPayload };
      payloadCycle.self = payloadCycle;
      assert.throws(
        () => mod.pinAliasQueueWithNative(payloadCycle, pinFallback),
        /json stringify failed/
      );
    }
  );

  await withMockNative(
    requiredNames,
    {
      resolveAliasSelectionStrategyJson: 'function () { return JSON.stringify("invalid"); }',
      pinAliasQueueJson: 'function () { return JSON.stringify({ queue: "bad", selectedCandidates: [] }); }'
    },
    async () => {
      const mod = await importSemantics('invalid-payload');
      assert.throws(
        () => mod.resolveAliasSelectionStrategyWithNative('antigravity', { enabled: true }, 'none'),
        /invalid payload/
      );
      assert.throws(
        () => mod.pinAliasQueueWithNative(pinPayload, pinFallback),
        /invalid payload/
      );
    }
  );

  await withMockNative(
    requiredNames,
    {
      resolveAliasSelectionStrategyJson: 'function () { return "not-json"; }',
      pinAliasQueueJson: 'function () { return "[]"; }'
    },
    async () => {
      const mod = await importSemantics('parse-catch-and-non-object');
      assert.throws(
        () => mod.resolveAliasSelectionStrategyWithNative('antigravity', { enabled: true }, 'none'),
        /invalid payload/
      );
      assert.throws(
        () => mod.pinAliasQueueWithNative(pinPayload, pinFallback),
        /invalid payload/
      );
    }
  );

  await withMockNative(
    requiredNames,
    {
      resolveAliasSelectionStrategyJson: 'function () { return JSON.stringify("none"); }',
      pinAliasQueueJson: 'function () { return "not-json"; }'
    },
    async () => {
      const mod = await importSemantics('pin-parse-catch');
      assert.throws(
        () => mod.pinAliasQueueWithNative(pinPayload, pinFallback),
        /invalid payload/
      );
    }
  );

  await withMockNative(
    requiredNames,
    {
      resolveAliasSelectionStrategyJson: 'function () { return ""; }',
      pinAliasQueueJson: 'function () { return ""; }'
    },
    async () => {
      const mod = await importSemantics('empty-result');
      assert.throws(
        () => mod.resolveAliasSelectionStrategyWithNative('antigravity', { enabled: true }, 'none'),
        /empty result/
      );
      assert.throws(
        () => mod.pinAliasQueueWithNative(pinPayload, pinFallback),
        /empty result/
      );
    }
  );

  await withMockNative(
    requiredNames,
    {
      resolveAliasSelectionStrategyJson: 'function () { throw new Error("strategy boom"); }',
      pinAliasQueueJson: 'function () { throw new Error("pin boom"); }'
    },
    async () => {
      const mod = await importSemantics('native-throws');
      assert.throws(
        () => mod.resolveAliasSelectionStrategyWithNative('antigravity', { enabled: true }, 'none'),
        /strategy boom/
      );
      assert.throws(
        () => mod.pinAliasQueueWithNative(pinPayload, pinFallback),
        /pin boom/
      );
    }
  );

  await withMockNative(
    requiredNames,
    {
      resolveAliasSelectionStrategyJson: 'function () { throw "strategy-string-boom"; }',
      pinAliasQueueJson: 'function () { throw "pin-string-boom"; }'
    },
    async () => {
      const mod = await importSemantics('native-throws-non-error');
      assert.throws(
        () => mod.resolveAliasSelectionStrategyWithNative('antigravity', { enabled: true }, 'none'),
        /strategy-string-boom/
      );
      assert.throws(
        () => mod.pinAliasQueueWithNative(pinPayload, pinFallback),
        /pin-string-boom/
      );
    }
  );

  await withNativeCandidatesHidden(async () => {
    setNativePath('/tmp/routecodex-missing-native-alias-selection.node');
    const mod = await importSemantics('missing-native');
    assert.throws(
      () => mod.resolveAliasSelectionStrategyWithNative('antigravity', { enabled: true }, 'none'),
      /required but unavailable/
    );
    assert.throws(
      () => mod.pinAliasQueueWithNative(pinPayload, pinFallback),
      /required but unavailable/
    );
  });

  setNativePath(undefined);
  console.log('✅ coverage-virtual-router-alias-selection-semantics passed');
}

runCoverage().catch((error) => {
  setNativePath(undefined);
  console.error('❌ coverage-virtual-router-alias-selection-semantics failed:', error);
  process.exit(1);
});
