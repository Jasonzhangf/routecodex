#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  collectV3BuildTestArtifactBudgetFailures,
  readV3BuildTestArtifactBudgetSources,
} from '../../scripts/architecture/verify-v3-build-test-artifact-budget.mjs';
import {
  builderCommandUsesOwnedV3Domain,
  currentProcessIdentity,
  enforceV3DebugBudget,
  lockOwnerMatchesProcess,
  releaseOwnedTestArtifacts,
  verifyV3DebugBudget,
} from '../../scripts/run-v3-cargo-test.mjs';

const root = resolve(new URL('../..', import.meta.url).pathname);
const wrapperPath = resolve(root, 'scripts', 'run-v3-cargo-test.mjs');
const manifestPath = join(root, 'Cargo.toml');
const sources = readV3BuildTestArtifactBudgetSources(root);
assert.deepEqual(collectV3BuildTestArtifactBudgetFailures(sources), []);
assert.equal(
  builderCommandUsesOwnedV3Domain(
    '123 cargo test --manifest-path v3/Cargo.toml -p routecodex-v3-server',
    () => root,
  ),
  true,
  'a builder in this V3 domain must block cleanup',
);
assert.equal(
  builderCommandUsesOwnedV3Domain(
    '124 cargo test --manifest-path v3/Cargo.toml -p routecodex-v3-server',
    () => '/tmp/foreign-routecodex/v3',
  ),
  false,
  'an isolated worktree builder must not block cleanup in this V3 domain',
);
assert.equal(
  builderCommandUsesOwnedV3Domain(
    `125 cargo test --manifest-path ${join(root, 'Cargo.toml')} -p routecodex-v3-server`,
    () => '/tmp/foreign-routecodex/v3',
  ),
  true,
  'an absolute manifest path into this V3 domain must block cleanup',
);
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
    name: 'explicit cargo target dir escape rejection removed',
    sources: {
      ...sources,
      wrapper: sources.wrapper.replace(
        'throw new Error(`external CARGO_TARGET_DIR is forbidden: ${suppliedTargetRoot}`);',
        'void suppliedTargetRoot;',
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
      wrapper: sources.wrapper.replace("    || /(?:^|\\s)-p\\s+routecodex-v3[-\\w]*/u.test(command)\n", ''),
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
    name: 'foreign V3 worktree isolation removed',
    sources: {
      ...sources,
      wrapper: sources.wrapper.replace(
        '  const relativeCwd = relative(v3Root, resolve(cwd));',
        "  const relativeCwd = '';",
      ),
    },
  },
  {
    name: 'raw V3 Cargo test bypass restored',
    sources: {
      ...sources,
      packageJson: sources.packageJson.replace('node scripts/run-v3-cargo-test.mjs', 'cargo test -p routecodex-v3-runtime'),
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
  let activeBuildCleanupCalled = false;
  assert.equal(await enforceV3DebugBudget({
    debugDir: fixture,
    maxBytes: 1,
    activeBuilders: () => ['123 cargo test --manifest-path v3/Cargo.toml'],
    cleanTestProfile: () => { activeBuildCleanupCalled = true; },
  }), null, 'active builds defer cache maintenance without changing a completed test result');
  assert.equal(activeBuildCleanupCalled, false);
  assert.equal(readFileSync(dependency, 'utf8'), 'dependency');
  let builderObservations = 0;
  assert.equal(await enforceV3DebugBudget({
    debugDir: fixture,
    maxBytes: 1,
    activeBuilders: () => ++builderObservations === 1 ? [] : ['123 cargo build'],
    cleanTestProfile: () => { activeBuildCleanupCalled = true; },
  }), null, 'a builder starting during measurement must prevent eviction');
  assert.equal(activeBuildCleanupCalled, false);
  assert.equal(readFileSync(dependency, 'utf8'), 'dependency');
  let cleaned = false;
  const postCleanupBytes = await enforceV3DebugBudget({
    debugDir: fixture,
    maxBytes: 1,
    activeBuilders: () => [],
    cleanTestProfile: () => {
      cleaned = true;
      rmSync(dependency);
      rmSync(fixture, { recursive: true });
    },
  });
  assert.equal(cleaned, true);
  assert.equal(postCleanupBytes, 0);
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

// --- Real CLI consumer: environment-controlled ps/cargo/du stubs --------
// These cases run the actual wrapper executable through Node so the terminal
// finally path, ps scan, budget measurement, and lock cleanup all execute for
// real. PATH is prefixed with a fixture bin directory so the wrapper's
// subprocess calls resolve to controlled stubs. No unrelated Rust crate is
// compiled; cargo/du only touch the fixture debug directory.

function writeExecutable(path, body) {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

const unrelatedArgvBytes = 2 * 1024 * 1024 + 64 * 1024;

function runWrapperFixture({ fixtureBin, env = {} }) {
  const cargoResult = spawnSync(
    process.execPath,
    [wrapperPath, '--locked', '-p', 'routecodex-v3-fixture'],
    {
      encoding: 'utf8',
      timeout: 120000,
      env: {
        ...process.env,
        PATH: `${fixtureBin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`,
        ...env,
      },
    },
  );
  return {
    status: cargoResult.status,
    signal: cargoResult.signal,
    stdout: cargoResult.stdout ?? '',
    stderr: cargoResult.stderr ?? '',
    error: cargoResult.error,
  };
}

const targetDir = join(root, 'target');
const cliFixture = mkdtempSync(join(tmpdir(), 'routecodex-v3-cli-budget-'));
try {
  const fixtureBin = join(cliFixture, 'bin');
  mkdirSync(fixtureBin, { recursive: true });

  // cargo stub: success run, no unrelated compile. Record invocations so the
  // test can prove whether profile cleanup was requested.
  writeExecutable(join(fixtureBin, 'cargo'), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(path.join(${JSON.stringify(cliFixture)}, 'cargo-calls.log'), JSON.stringify(args) + '\\n');
if (args.includes('clean')) fs.writeFileSync(path.join(${JSON.stringify(cliFixture)}, 'cleaned'), 'cleaned\\n');
else fs.mkdirSync(path.join(process.env.CARGO_TARGET_DIR, 'debug'), { recursive: true });
process.exitCode = 0;
`);

  // du stub: small cache for the unrelated scenario, over budget otherwise,
  // dropping to small after a cargo clean.
  writeExecutable(join(fixtureBin, 'du'), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const scenario = process.env.FIXTURE_SCENARIO || 'unrelated';
const cleaned = fs.existsSync(path.join(${JSON.stringify(cliFixture)}, 'cleaned'));
const over = scenario !== 'unrelated' && !cleaned;
process.stdout.write((over ? '2097153' : '1024') + '\\t' + process.argv[process.argv.length - 1] + '\\n');
process.exitCode = 0;
`);

  // ps stub: argument-driven. The legacy full inventory returns >2 MiB of
  // unrelated argv so the pre-fix synchronous scan overflows. The two-phase
  // inventory returns only PID and ucomm; selected command queries return the
  // per-scenario command.
  writeExecutable(join(fixtureBin, 'ps'), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const logPath = path.join(${JSON.stringify(cliFixture)}, 'ps-calls.log');
const args = process.argv.slice(2);
fs.appendFileSync(logPath, JSON.stringify(args) + '\\n');
const scenario = process.env.FIXTURE_SCENARIO || 'unrelated';
const manifest = process.env.FIXTURE_PS_MANIFEST || '';
const fixturePid = process.env.FIXTURE_PID || '424242';
const has = (value) => args.includes(value);
if (has('-axo') && has('pid=,ucomm=,command=')) {
  const padding = 'x'.repeat(${unrelatedArgvBytes});
  const lines = [];
  for (let i = 1; i <= 8; i += 1) lines.push((900000 + i) + ' unrelatedproc ' + padding);
  process.stdout.write(lines.join('\\n') + '\\n');
  process.exitCode = 0;
}
else if (has('-axo') && has('pid=,ucomm=')) {
  const lines = ['900001 node', '900002 python', '900003 ruby'];
  if (manifest) lines.push(fixturePid + ' cargo');
  process.stdout.write(lines.join('\\n') + '\\n');
  process.exitCode = 0;
}
else if (has('-ww') && has('-p')) {
  const pid = args[args.indexOf('-p') + 1];
  if (scenario === 'query-failure' && pid === process.env.FIXTURE_FAIL_PID) {
    process.exitCode = 1;
  } else {
    const command = scenario === 'long-rustc'
      ? 'rustc --crate-name long_crate ' + 'y'.repeat(${unrelatedArgvBytes}) + ' --out-dir ' + manifest
      : 'cargo test --manifest-path ' + manifest;
    const ucomm = command.startsWith('rustc') ? 'rustc' : 'cargo';
    process.stdout.write(pid + ' ' + ucomm + ' ' + command + '\\n');
    process.exitCode = 0;
  }
} else {
  process.exitCode = 1;
}
`);

  // lsof stub: foreign-tree cwd for the foreign scenario.
  writeExecutable(join(fixtureBin, 'lsof'), `#!/usr/bin/env node
const args = process.argv.slice(2);
const pid = args[args.indexOf('-p') + 1] || '0';
process.stdout.write('p' + pid + '\\n' + 'n' + (process.env.FIXTURE_FOREIGN_CWD || '/tmp/foreign-routecodex/v3') + '\\n');
process.exitCode = 0;
`);

  // GREEN: the two-phase streamed scan returns 0, never reads unrelated
  // command lines, releases the lock, and preserves the passing test.
  const psLogPath = join(cliFixture, 'ps-calls.log');
  const cargoLogPath = join(cliFixture, 'cargo-calls.log');
  if (existsSync(psLogPath)) rmSync(psLogPath);
  if (existsSync(join(cliFixture, 'cleaned'))) rmSync(join(cliFixture, 'cleaned'));
  const greenResult = runWrapperFixture({ fixtureBin, env: { FIXTURE_SCENARIO: 'unrelated' } });
  assert.equal(greenResult.status, 0, `a677153-unrelated-argv-inventory: two-phase scan must pass (stderr: ${greenResult.stderr})`);
  assert.match(greenResult.stdout, /debug allocation after cleanup/u, 'a677153-unrelated-argv-inventory: passing test result must be preserved');
  assert.ok(existsSync(cargoLogPath), 'a677153-unrelated-argv-inventory: cargo consumer must run');
  const psCalls = existsSync(psLogPath) ? readFileSync(psLogPath, 'utf8').trim().split('\n').filter(Boolean) : [];
  assert.ok(psCalls.length >= 1, 'a677153-unrelated-argv-inventory: ps must be invoked');
  for (const call of psCalls) {
    const parsed = JSON.parse(call);
    assert.notEqual(parsed[0], '-ww', 'a677153-unrelated-argv-inventory: unrelated PIDs must not be queried for command');
  }
  assert.ok(!existsSync(join(targetDir, '.routecodex-v3-test.lock')), 'a677153-unrelated-argv-inventory: lock must be released');

  // GREEN control: an owned builder (command into this manifest) defers
  // cleanup; profile cleanup is not invoked and the result is preserved.
  if (existsSync(psLogPath)) rmSync(psLogPath);
  if (existsSync(join(cliFixture, 'cleaned'))) rmSync(join(cliFixture, 'cleaned'));
  process.env.FIXTURE_PS_MANIFEST = manifestPath;
  const ownedResult = runWrapperFixture({ fixtureBin, env: { FIXTURE_SCENARIO: 'owned' } });
  delete process.env.FIXTURE_PS_MANIFEST;
  assert.equal(ownedResult.status, 0, `a677153-owned-builder-defers-cleanup: owned builder must defer without failing (stderr: ${ownedResult.stderr})`);
  assert.match(ownedResult.stderr, /refusing cache eviction while V3 builders are active/u, 'a677153-owned-builder-defers-cleanup: deferred diagnostic required');
  const ownedCalls = existsSync(psLogPath) ? readFileSync(psLogPath, 'utf8').trim().split('\n').filter(Boolean) : [];
  assert.ok(ownedCalls.some((call) => JSON.parse(call)[0] === '-ww'), 'a677153-owned-builder-defers-cleanup: owned builder command must be streamed');
  const ownedCargoCalls = existsSync(cargoLogPath) ? readFileSync(cargoLogPath, 'utf8').trim().split('\n').filter(Boolean) : [];
  assert.ok(ownedCargoCalls.every((call) => !JSON.parse(call).includes('clean')), 'a677153-owned-builder-defers-cleanup: profile cleanup must not run');

  // GREEN control: a foreign-tree builder (command in another worktree) does
  // not block cleanup; profile cleanup runs under the over-budget path.
  if (existsSync(psLogPath)) rmSync(psLogPath);
  if (existsSync(join(cliFixture, 'cleaned'))) rmSync(join(cliFixture, 'cleaned'));
  process.env.FIXTURE_PS_MANIFEST = '/tmp/foreign-routecodex/v3/Cargo.toml';
  process.env.FIXTURE_FOREIGN_CWD = '/tmp/foreign-routecodex/v3';
  const foreignResult = runWrapperFixture({ fixtureBin, env: { FIXTURE_SCENARIO: 'foreign' } });
  delete process.env.FIXTURE_PS_MANIFEST;
  delete process.env.FIXTURE_FOREIGN_CWD;
  assert.equal(foreignResult.status, 0, `a677153-foreign-builder-allows-cleanup: foreign tree must not block cleanup (stderr: ${foreignResult.stderr})`);
  assert.doesNotMatch(foreignResult.stderr, /refusing cache eviction/u, 'a677153-foreign-builder-allows-cleanup: foreign tree must not defer');
  assert.match(foreignResult.stdout, /debug allocation after cleanup/u);
  const foreignCargoCalls = existsSync(cargoLogPath) ? readFileSync(cargoLogPath, 'utf8').trim().split('\n').filter(Boolean) : [];
  assert.ok(foreignCargoCalls.some((call) => JSON.parse(call).includes('clean')), 'a677153-foreign-builder-allows-cleanup: profile cleanup must run');

  // GREEN control: a selected rustc command longer than the old sync buffer
  // must be fully streamed; owned tail prevents eviction.
  if (existsSync(psLogPath)) rmSync(psLogPath);
  if (existsSync(join(cliFixture, 'cleaned'))) rmSync(join(cliFixture, 'cleaned'));
  process.env.FIXTURE_PS_MANIFEST = manifestPath;
  const longResult = runWrapperFixture({ fixtureBin, env: { FIXTURE_SCENARIO: 'long-rustc' } });
  delete process.env.FIXTURE_PS_MANIFEST;
  assert.equal(longResult.status, 0, `a677153-long-selected-rustc-command: long owned command must be streamed (stderr: ${longResult.stderr})`);
  assert.match(longResult.stderr, /refusing cache eviction while V3 builders are active/u, 'a677153-long-selected-rustc-command: owned long command must block eviction');

  // GREEN control: a ps inventory failure must fail cleanup explicitly and
  // never proceed to profile eviction.
  const psFailPath = join(fixtureBin, 'ps');
  const psOkSource = readFileSync(psFailPath, 'utf8');
  writeExecutable(psFailPath, `#!/usr/bin/env node
process.exit(1);
`);
  if (existsSync(psLogPath)) rmSync(psLogPath);
  if (existsSync(cargoLogPath)) rmSync(cargoLogPath);
  if (existsSync(join(cliFixture, 'cleaned'))) rmSync(join(cliFixture, 'cleaned'));
  const failResult = runWrapperFixture({ fixtureBin, env: { FIXTURE_SCENARIO: 'query-failure' } });
  assert.notEqual(failResult.status, 0, 'a677153-query-failure-prevents-cleanup: ps failure must fail wrapper');
  assert.match(failResult.stderr, /unable to inspect active V3 builders/u, 'a677153-query-failure-prevents-cleanup: failure must surface explicitly');
  const failedCalls = readFileSync(cargoLogPath, 'utf8').trim().split('\n').filter(Boolean);
  assert.ok(failedCalls.every((call) => !JSON.parse(call).includes('clean')),
    'a677153-query-failure-prevents-cleanup: failed inventory must not evict artifacts');
  assert.ok(!existsSync(join(targetDir, '.routecodex-v3-test.lock')));
  writeExecutable(psFailPath, psOkSource);
} finally {
  rmSync(cliFixture, { recursive: true, force: true });
}

process.stdout.write('[v3-build-test-artifact-budget-red-fixtures] PASS\n');
