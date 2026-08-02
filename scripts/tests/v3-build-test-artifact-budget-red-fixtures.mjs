#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  collectV3BuildTestArtifactBudgetFailures,
  readV3BuildTestArtifactBudgetSources,
} from '../architecture/verify-v3-build-test-artifact-budget.mjs';
import {
  currentProcessIdentity,
  enforceV3DebugBudget,
  lockOwnerMatchesProcess,
  releaseOwnedTestArtifacts,
  verifyV3DebugBudget,
} from '../run-v3-cargo-test.mjs';

const root = resolve('.');
const sources = readV3BuildTestArtifactBudgetSources(root);
assert.deepEqual(collectV3BuildTestArtifactBudgetFailures(sources), []);
assert.equal(
  lockOwnerMatchesProcess(
    { pid: 123, processStartedAt: '2026-08-02T00:00:00.000Z' },
    { pid: 123, processStartedAt: '2026-08-02T00:00:00.000Z' },
  ),
  true,
);
assert.equal(
  lockOwnerMatchesProcess(
    { pid: 123, processStartedAt: '2026-08-02T00:00:00.000Z' },
    { pid: 123, processStartedAt: '2026-08-02T01:00:00.000Z' },
  ),
  false,
  'PID reuse must not preserve a stale lock',
);
const previousPath = process.env.PATH;
try {
  const noPsPath = mkdtempSync(join(tmpdir(), 'routecodex-v3-no-ps-'));
  process.env.PATH = noPsPath;
  assert.deepEqual(currentProcessIdentity(process.ppid), {
    pid: process.ppid,
    processStartedAt: null,
  });
  rmSync(noPsPath, { recursive: true, force: true });
} finally {
  process.env.PATH = previousPath;
}

const mutations = [
  {
    name: 'test profile incremental cache restored',
    sources: { ...sources, cargoManifest: sources.cargoManifest.replace('incremental = false', 'incremental = true') },
  },
  {
    name: 'budget raised above 2 GiB',
    sources: { ...sources, wrapper: sources.wrapper.replace('MAX_DEBUG_BYTES = 2147483648', 'MAX_DEBUG_BYTES = 3221225472') },
  },
  {
    name: 'explicit cargo target dir ignored',
    sources: {
      ...sources,
      wrapper: sources.wrapper.replace(
        "const targetDir = suppliedCargoTargetDir\n  ? join(suppliedTargetRoot, 'routecodex-v3-test')\n  : join(repoRoot, 'v3', 'target');",
        "const targetDir = join(repoRoot, 'v3', 'target');",
      ),
    },
  },
  {
    name: 'relative target dir no longer normalized for Cargo cwd',
    sources: {
      ...sources,
      wrapper: sources.wrapper.replace('CARGO_TARGET_DIR: targetDir,', ''),
    },
  },
  {
    name: 'explicit shared target dir is no longer isolated',
    sources: {
      ...sources,
      wrapper: sources.wrapper.replace("join(suppliedTargetRoot, 'routecodex-v3-test')", 'suppliedTargetRoot'),
    },
  },
  {
    name: 'stale lock owner recovery removed',
    sources: {
      ...sources,
      wrapper: sources.wrapper.replace("const lockOwnerPath = join(lockDir, 'owner.json');", "const lockOwnerPath = join(lockDir, 'owner.lock');"),
    },
  },
  {
    name: 'stale lock process start identity removed',
    sources: {
      ...sources,
      wrapper: sources.wrapper.replace('processStartedAt: identity.processStartedAt', 'processStartedAt: undefined'),
    },
  },
  {
    name: 'lock acquisition requires process enumeration again',
    sources: {
      ...sources,
      wrapper: sources.wrapper.replace('const identity = ownProcessIdentity();', 'const identity = currentProcessIdentity(process.pid);'),
    },
  },
  {
    name: 'failed lock owner initialization leaves ownerless lock',
    sources: {
      ...sources,
      wrapper: sources.wrapper.replace('    removePath(lockDir);\n    throw error;', '    throw error;'),
    },
  },
  {
    name: 'process start inspection becomes locale dependent',
    sources: {
      ...sources,
      wrapper: sources.wrapper.replace("    env: { ...process.env, LC_ALL: 'C' },\n", ''),
    },
  },
  {
    name: 'ps inspection error becomes hard cargo test failure',
    sources: {
      ...sources,
      wrapper: sources.wrapper.replace(
        'if (result.error) return { pid, processStartedAt: null };',
        "if (result.error) throw new Error(`unable to inspect process ${pid}: ${result.error.message}`);",
      ),
    },
  },
  {
    name: 'live pid fallback before ps inspection removed',
    sources: {
      ...sources,
      wrapper: sources.wrapper.replace('  if (!processExists(pid)) return null;\n', ''),
    },
  },
  {
    name: 'timestamp rcgu deletion restored',
    sources: {
      ...sources,
      wrapper: sources.wrapper.replace(
        'if (belongsToExecutable) removePath(path);',
        'const createdByFailedInvocation = statSync(path).mtimeMs >= invocationStartedAtMs;\n    if (belongsToExecutable || createdByFailedInvocation) removePath(path);',
      ),
    },
  },
  {
    name: 'bare V3 package builder detection removed',
    sources: {
      ...sources,
      wrapper: sources.wrapper.replace("        || /(?:^|\\s)-p\\s+routecodex-v3[-\\w]*/u.test(command)\n", ''),
    },
  },
  {
    name: 'bare workspace builder detection removed',
    sources: {
      ...sources,
      wrapper: sources.wrapper.replace(
        'function isBareWorkspaceCargoBuildOrTest(command)',
        'function isBareWorkspaceCargoBuildOrTestDisabled(command)',
      ),
    },
  },
  {
    name: 'raw V3 Cargo test bypass restored',
    sources: {
      ...sources,
      packageJson: sources.packageJson.replace('node scripts/run-v3-cargo-test.mjs -p routecodex-v3-runtime', 'cargo test --manifest-path v3/Cargo.toml -p routecodex-v3-runtime'),
    },
  },
  {
    name: 'module registry downgraded to design',
    sources: { ...sources, moduleRegistry: sources.moduleRegistry.replace('status: active', 'status: design') },
  },
];

for (const mutation of mutations) {
  assert.notDeepEqual(collectV3BuildTestArtifactBudgetFailures(mutation.sources), [], mutation.name);
}

const fixture = mkdtempSync(join(tmpdir(), 'routecodex-v3-test-budget-'));
try {
  const deps = join(fixture, 'deps');
  mkdirSync(deps, { recursive: true });
  const executable = join(deps, 'sample_contract-deadbeef');
  const depInfo = `${executable}.d`;
  const object = `${executable}.unit.rcgu.o`;
  const foreignObject = join(deps, 'foreign_contract.unit.rcgu.o');
  const dependency = join(deps, 'libserde-deadbeef.rlib');
  writeFileSync(executable, 'test');
  writeFileSync(depInfo, 'dep-info');
  writeFileSync(object, 'object');
  writeFileSync(foreignObject, 'foreign-object');
  writeFileSync(dependency, 'dependency');
  await releaseOwnedTestArtifacts({ executables: [executable], debugDepsDir: deps });
  assert.throws(() => readFileSync(executable), /ENOENT/u);
  assert.throws(() => readFileSync(depInfo), /ENOENT/u);
  assert.throws(() => readFileSync(object), /ENOENT/u);
  assert.equal(readFileSync(foreignObject, 'utf8'), 'foreign-object');
  assert.equal(readFileSync(dependency, 'utf8'), 'dependency');
  assert.throws(() => verifyV3DebugBudget({ debugDir: fixture, maxBytes: 1 }), /exceeds/u);
  assert.throws(
    () => enforceV3DebugBudget({ debugDir: fixture, maxBytes: 1, activeBuilders: () => ['123 cargo test --manifest-path v3/Cargo.toml'] }),
    /refusing cache eviction while V3 builders are active/u,
  );
  let cleaned = false;
  const postCleanupBytes = enforceV3DebugBudget({
    debugDir: fixture,
    maxBytes: 1,
    activeBuilders: () => [],
    cleanTestProfile: () => {
      cleaned = true;
      rmSync(dependency);
      rmSync(deps, { recursive: true });
    },
  });
  assert.equal(cleaned, true);
  assert.equal(postCleanupBytes, 0);
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

process.stdout.write('[v3-build-test-artifact-budget-red-fixtures] PASS\n');
