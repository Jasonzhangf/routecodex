#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const moduleUrl = pathToFileURL(
  path.join(repoRoot, 'dist', 'router', 'virtual-router', 'engine-selection', 'native-router-hotpath-quota-buckets.js')
).href;
const nativeNodePath = path.join(repoRoot, 'dist', 'native', 'router_hotpath_napi.node');

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

async function importFresh(tag) {
  return import(`${moduleUrl}?case=${tag}_${Date.now()}_${Math.random().toString(16).slice(2)}`);
}

async function withTempModule(content, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'llms-native-hotpath-'));
  const file = path.join(dir, 'mock-native.cjs');
  await fs.writeFile(file, content, 'utf8');
  try {
    await fn(file);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function withTempCwd(nextCwd, fn) {
  const prev = process.cwd();
  process.chdir(nextCwd);
  try {
    await fn();
  } finally {
    process.chdir(prev);
  }
}

function workspaceNativeCandidatePaths() {
  const rustCore = path.join(repoRoot, 'rust-core', 'target');
  return [
    path.join(repoRoot, 'dist', 'native', 'router_hotpath_napi.node'),
    path.join(rustCore, 'release', 'router_hotpath_napi.node'),
    path.join(rustCore, 'release', 'librouter_hotpath_napi.dylib'),
    path.join(rustCore, 'release', 'librouter_hotpath_napi.so'),
    path.join(rustCore, 'release', 'router_hotpath_napi.dll'),
    path.join(rustCore, 'debug', 'router_hotpath_napi.node'),
    path.join(rustCore, 'debug', 'librouter_hotpath_napi.dylib'),
    path.join(rustCore, 'debug', 'librouter_hotpath_napi.so'),
    path.join(rustCore, 'debug', 'router_hotpath_napi.dll')
  ];
}

async function withWorkspaceNativeMasked(fn) {
  const backups = [];
  for (const candidate of workspaceNativeCandidatePaths()) {
    try {
      await fs.access(candidate);
    } catch {
      continue;
    }
    const backupPath = `${candidate}.bak.${Date.now()}.${Math.random().toString(16).slice(2)}`;
    await fs.rename(candidate, backupPath);
    backups.push({ candidate, backupPath });
  }

  try {
    await fn();
  } finally {
    for (const item of backups.reverse()) {
      await fs.rename(item.backupPath, item.candidate);
    }
  }
}

function sampleEntries(now) {
  return [
    { key: 'p1', order: 0, hasQuota: false, inPool: true },
    { key: 'p2', order: 1, hasQuota: true, inPool: true, priorityTier: 2, selectionPenalty: 3 },
    { key: 'p3', order: 2, hasQuota: true, inPool: false, priorityTier: 1, selectionPenalty: 1 },
    { key: 'p4', order: 3, hasQuota: true, inPool: true, cooldownUntil: now + 9999, priorityTier: 0, selectionPenalty: 1 },
    { key: 'p5', order: 4, hasQuota: true, inPool: true, blacklistUntil: now + 9999, priorityTier: 0, selectionPenalty: 1 }
  ];
}

function assertNativeUnavailableError(fn) {
  assert.throws(fn, /native .* required but unavailable/);
}

async function main() {
  const now = Date.now();

  clearNativeEnv();
  {
    const mod = await importFresh('resolve-empty');
    assert.equal(mod.resolveNativeModuleUrlFromEnv(), undefined);
  }

  await withWorkspaceNativeMasked(async () => {
    clearNativeEnv();
    setEnvVar(
      'ROUTECODEX_LLMS_ROUTER_NATIVE_PATH',
      path.join(os.tmpdir(), `masked-missing-${Date.now()}-${Math.random().toString(16).slice(2)}.node`)
    );
    const mod = await importFresh('workspace-masked-missing');
    assert.equal(mod.getNativeRouterHotpathSource(), 'unavailable');
    assertNativeUnavailableError(() => mod.buildQuotaBuckets(sampleEntries(now), now));
    assertNativeUnavailableError(() => mod.buildQuotaBucketsWithMode(sampleEntries(now), now, 'native-only'));
  });

  await withTempModule(
    `const real = require(${JSON.stringify(nativeNodePath)});
    module.exports = { ...real };
    module.exports.computeQuotaBucketsJson = () => JSON.stringify({
      priorities: [7, 'x'],
      buckets: [{
        priority: 7,
        entries: [
          42,
          { key: '', penalty: 9, order: 99 },
          { key: 'native-key', penalty: 4, order: 11 },
          { key: 'native-zero', penalty: 'bad', order: 'bad' }
        ]
      }, {
        priority: 'bad',
        entries: [{ key: 'ignored', penalty: 1, order: 1 }]
      }]
    });`,
    async (modulePath) => {
      clearNativeEnv();
      setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
      const mod = await importFresh('native-ok');
      assert.equal(mod.getNativeRouterHotpathSource(), 'native');
      const result = mod.buildQuotaBucketsWithMode(sampleEntries(now), now, 'auto');
      assert.deepEqual(result.priorities, [7]);
      assert.equal(result.buckets.get(7)?.[0]?.key, 'native-key');
      assert.equal(result.buckets.get(7)?.[1]?.key, 'native-zero');
      assert.equal(result.buckets.get(7)?.[1]?.penalty, 0);
      assert.equal(result.buckets.get(7)?.[1]?.order, 0);
      assert.ok(String(mod.resolveNativeModuleUrlFromEnv() || '').startsWith('file://'));
      assert.throws(
        () => mod.buildQuotaBucketsWithMode(sampleEntries(now), now, 'legacy'),
        /unsupported hotpath mode/
      );
    }
  );

  await withTempModule(
    `const real = require(${JSON.stringify(nativeNodePath)});
    module.exports = { ...real };
    module.exports.computeQuotaBucketsJson = () => 'not-json';`,
    async (modulePath) => {
      clearNativeEnv();
      setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
      const mod = await importFresh('native-invalid-json');
      assert.equal(mod.getNativeRouterHotpathSource(), 'native');
      assertNativeUnavailableError(() => mod.buildQuotaBuckets(sampleEntries(now), now));
    }
  );

  await withTempModule(
    `const real = require(${JSON.stringify(nativeNodePath)});
    module.exports = { ...real };
    module.exports.computeQuotaBucketsJson = () => 'null';`,
    async (modulePath) => {
      clearNativeEnv();
      setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
      const mod = await importFresh('native-null-json');
      assertNativeUnavailableError(() => mod.buildQuotaBuckets(sampleEntries(now), now));
    }
  );

  await withTempModule(
    `const real = require(${JSON.stringify(nativeNodePath)});
    module.exports = { ...real };
    module.exports.computeQuotaBucketsJson = () => '';`,
    async (modulePath) => {
      clearNativeEnv();
      setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
      const mod = await importFresh('native-empty');
      assertNativeUnavailableError(() => mod.buildQuotaBuckets(sampleEntries(now), now));
    }
  );

  await withTempModule(
    `const real = require(${JSON.stringify(nativeNodePath)});
    module.exports = { ...real };
    module.exports.computeQuotaBucketsJson = () => { throw new Error('boom'); };`,
    async (modulePath) => {
      clearNativeEnv();
      setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
      const mod = await importFresh('native-throws');
      assertNativeUnavailableError(() => mod.buildQuotaBuckets(sampleEntries(now), now));
    }
  );

  await withTempModule(
    `module.exports = { notComputeQuotaBucketsJson: true };`,
    async (modulePath) => {
      clearNativeEnv();
      setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
      const mod = await importFresh('native-object-without-function');
      const source = mod.getNativeRouterHotpathSource();
      assert.ok(source === 'native' || source === 'unavailable');
      if (source === 'native') {
        const result = mod.buildQuotaBuckets(sampleEntries(now), now);
        assert.ok((result.buckets.get(100) || []).some((row) => row.key === 'p1'));
      } else {
        assertNativeUnavailableError(() => mod.buildQuotaBuckets(sampleEntries(now), now));
      }
    }
  );

  await withTempModule(
    `const real = require(${JSON.stringify(nativeNodePath)});
    module.exports = { ...real };
    module.exports.computeQuotaBucketsJson = () => JSON.stringify({
      priorities: [12],
      buckets: [{ priority: 12, entries: [{ key: 'relative-path-ok', penalty: 2, order: 1 }] }]
    });`,
    async (modulePath) => {
      await withTempCwd(path.dirname(modulePath), async () => {
        clearNativeEnv();
        setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', path.basename(modulePath));
        setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_DISABLE', '1');
        const mod = await importFresh('native-relative-path');
        assert.equal(mod.getNativeRouterHotpathSource(), 'native');
        const result = mod.buildQuotaBuckets(sampleEntries(now), now);
        assert.deepEqual(result.priorities, [12]);
        assert.equal(result.buckets.get(12)?.[0]?.key, 'relative-path-ok');
        assert.ok(String(mod.resolveNativeModuleUrlFromEnv() || '').startsWith('file://'));
      });
    }
  );

  clearNativeEnv();
  console.log('✅ coverage-virtual-router-native-hotpath passed');
}

main().catch((error) => {
  clearNativeEnv();
  console.error('❌ coverage-virtual-router-native-hotpath failed:', error);
  process.exit(1);
});
