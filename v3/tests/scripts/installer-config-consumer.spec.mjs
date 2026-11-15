import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';

const v3Root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const repoRoot = path.resolve(v3Root, '..');
const expectedVersion = JSON.parse(fs.readFileSync(path.join(v3Root, 'package.json'), 'utf8')).version;

let candidateCli;
let ownedCliTarget;

function executable(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function prepareCandidateCli() {
  const supplied = process.env.ROUTECODEX_INSTALLER_TEST_CONFIG_BINARY;
  if (supplied) {
    candidateCli = path.resolve(supplied);
    assert.equal(path.isAbsolute(candidateCli), true, 'candidate CLI path must be absolute');
    assert.equal(executable(candidateCli), true, `candidate CLI is not executable: ${candidateCli}`);
    return;
  }

  ownedCliTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-installer-config-cli-'));
  const cargo = process.env.CARGO || 'cargo';
  const build = spawnSync(
    cargo,
    ['build', '--locked', '--manifest-path', path.join(repoRoot, 'v3', 'Cargo.toml'), '-p', 'routecodex-v3-cli'],
    {
      cwd: repoRoot,
      env: { ...process.env, CARGO_TARGET_DIR: ownedCliTarget },
      encoding: 'utf8',
      timeout: 20 * 60_000,
    },
  );
  assert.equal(
    build.status,
    0,
    `candidate V3 CLI build failed:\n${build.stdout || ''}\n${build.stderr || build.error?.message || ''}`,
  );

  const metadata = spawnSync(
    cargo,
    ['metadata', '--manifest-path', path.join(repoRoot, 'v3', 'Cargo.toml'), '--no-deps', '--format-version', '1'],
    {
      cwd: repoRoot,
      env: { ...process.env, CARGO_TARGET_DIR: ownedCliTarget },
      encoding: 'utf8',
    },
  );
  assert.equal(metadata.status, 0, `candidate Cargo metadata failed:\n${metadata.stderr || metadata.stdout || ''}`);
  const targetDirectory = JSON.parse(metadata.stdout).target_directory;
  candidateCli = path.join(targetDirectory, 'debug', process.platform === 'win32' ? 'rccv3.exe' : 'rccv3');
  assert.equal(executable(candidateCli), true, `candidate CLI is not executable: ${candidateCli}`);
}

before(prepareCandidateCli);

after(() => {
  if (ownedCliTarget) fs.rmSync(ownedCliTarget, { recursive: true, force: true });
});

function appendJsonLine(filePath, value) {
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`);
}

function writeExecutable(filePath, source) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, source);
  fs.chmodSync(filePath, 0o755);
}

function writeProvider(configPath) {
  const providerPath = path.join(path.dirname(configPath), 'provider', 'p1', 'config.v2.toml');
  fs.mkdirSync(path.dirname(providerPath), { recursive: true });
  fs.writeFileSync(
    providerPath,
    `version = "2.0.0"
providerId = "p1"
[provider]
id = "p1"
enabled = true
type = "openai_chat"
baseURL = "http://127.0.0.1:9/v1"
defaultModel = "m1"
[provider.auth]
type = "apikey"
apiKey = "fixture-only"
[provider.models."m1"]
supportsStreaming = true
`,
  );
}

function writeValidUserConfig(configPath, ports = [49181]) {
  writeProvider(configPath);
  const servers = ports.map((port, index) => {
    const name = index === 0 ? 'primary' : `secondary${index}`;
    return `[servers.${name}]
bind = "127.0.0.1"
port = ${port}
[servers.${name}.routes.default]
tiers = [[{ use = "p1/m1" }]]`;
  });
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `version = 3\n\n${servers.join('\n\n')}\n`);
}

function writeInvalidUserConfig(configPath) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(
    configPath,
    `version = 3

[servers.primary]
bind = "127.0.0.1"
port = 49181

this is not valid toml
`,
  );
}

function writeLegacyConfig(configPath) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(
    configPath,
    `version = 3
[servers.legacy]
bind = "127.0.0.1"
port = 49200
routing_group = "default"
[providers.test]
type = "responses"
base_url = "http://127.0.0.1:9/v1"
default_model = "test"
auth = { type = "api_key", entries = [{ alias = "key", env = "V3_INSTALLER_TEST_KEY" }] }
[providers.test.models.test]
[route_groups.default.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "test", model = "test", key = "key", priority = 1 }]
`,
  );
}

function createFixture({ defaultConfig = true, defaultPorts = [49181, 49182] } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-installer-config-'));
  const fixture = path.join(base, 'fixture');
  const home = path.join(base, 'home');
  const bin = path.join(base, 'bin');
  const evidence = path.join(base, 'evidence');
  const temp = path.join(base, 'tmp');
  const state = path.join(base, 'state');
  fs.mkdirSync(path.join(fixture, 'scripts', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(fixture, 'v3'), { recursive: true });
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(evidence, { recursive: true });
  fs.mkdirSync(temp, { recursive: true });
  fs.mkdirSync(state, { recursive: true });

  fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ name: 'installer-config-fixture', private: true }));
  fs.writeFileSync(path.join(fixture, 'v3', 'package.json'), JSON.stringify({ name: 'routecodex-v3', version: expectedVersion }));
  fs.writeFileSync(path.join(fixture, 'v3', 'Cargo.toml'), '# fixture marker\n');
  for (const relative of [
    'scripts/install-release.sh',
    'scripts/install-global.sh',
    'scripts/lib/install-lifecycle-lock.sh',
  ]) {
    fs.copyFileSync(path.join(repoRoot, relative), path.join(fixture, relative));
  }
  fs.writeFileSync(
    path.join(fixture, 'scripts', 'cleanup-stale-server-pids.mjs'),
    `import fs from 'node:fs';
fs.appendFileSync(process.env.INSTALLER_TEST_LOG, JSON.stringify({ command: 'cleanup-stale-server-pids', args: process.argv.slice(2) }) + '\\n');
`,
  );

  const defaultPath = path.join(home, '.rcc', 'config.toml');
  if (defaultConfig) writeValidUserConfig(defaultPath, defaultPorts);
  else fs.mkdirSync(path.dirname(defaultPath), { recursive: true });

  const commandDispatcher = path.join(bin, 'command-dispatcher.mjs');
  writeExecutable(
    commandDispatcher,
    `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const record = (entry) => fs.appendFileSync(process.env.INSTALLER_TEST_LOG, JSON.stringify(entry) + '\\n');
record({ command, args });

function configPath() {
  const index = args.findIndex((arg) => arg === '-c' || arg === '--config');
  return index >= 0 ? args[index + 1] : undefined;
}

function checkConfig(filePath) {
  const checked = spawnSync(
    process.env.ROUTECODEX_INSTALLER_TEST_CONFIG_BINARY,
    ['config', 'check', '-c', filePath],
    { env: process.env, stdio: 'inherit' },
  );
  record({ command: 'delegate-config-check', config: filePath, status: checked.status ?? null, signal: checked.signal ?? null });
  return checked.status ?? 1;
}

if (args[0] === '--version') {
  process.stdout.write(process.env.INSTALLER_TEST_COMMAND_VERSION + '\\n');
  process.exit(0);
}
if (command === 'rccv3' && args[0] === '--help') process.exit(0);
if (command === 'rccv3' && args[0] === 'config' && args[1] === 'check') {
  process.exit(checkConfig(configPath()));
}
if ((command === 'rcc' || command === 'routecodex') && args[0] === 'restart') {
  const selected = configPath();
  if (!selected) process.exit(2);
  const checked = checkConfig(selected);
  if (checked !== 0) process.exit(checked);
  record({ command, args, disposition: 'restart-recorded-not-executed' });
  process.exit(0);
}
if (command === 'rcc' || command === 'routecodex') process.exit(2);
process.exit(2);
`,
  );

  writeExecutable(
    path.join(bin, 'npm'),
    `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const record = (entry) => fs.appendFileSync(process.env.INSTALLER_TEST_LOG, JSON.stringify(entry) + '\\n');
record({ command: 'npm', args });

const exact = (expected) => expected.length === args.length && expected.every((value, index) => value === args[index]);
if (exact(['config', 'get', 'prefix'])) {
  process.stdout.write(process.env.npm_config_prefix + '\\n');
  process.exit(0);
}
if (exact(['root', '-g'])) {
  process.stdout.write(path.join(process.env.npm_config_prefix, 'lib', 'node_modules') + '\\n');
  process.exit(0);
}
if (exact(['--prefix', 'v3', 'run', 'test:install-cleanup'])) process.exit(0);
if (exact(['--prefix', 'v3', 'run', 'install'])) {
  const target = path.join(process.env.HOME, '.local', 'bin');
  fs.mkdirSync(target, { recursive: true });
  for (const name of ['rccv3', 'routecodex', 'rcc']) {
    const link = path.join(target, name);
    try { fs.unlinkSync(link); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    fs.symlinkSync(process.env.INSTALLER_TEST_COMMAND_DISPATCHER, link);
  }
  record({ command: 'fixture-install', created: ['rccv3', 'routecodex', 'rcc'], disposition: 'recorded-not-published' });
  process.exit(0);
}
process.exit(2);
`,
  );

  for (const name of ['rccv3', 'routecodex', 'rcc']) {
    fs.symlinkSync(commandDispatcher, path.join(bin, name));
  }
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));

  writeExecutable(
    path.join(bin, 'cargo'),
    `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(process.env.INSTALLER_TEST_LOG, JSON.stringify({ command: 'cargo', args }) + '\\n');
if (args.length === 1 && args[0] === '--version') {
  process.stdout.write('cargo fixture-version\\n');
  process.exit(0);
}
process.exit(2);
`,
  );
  writeExecutable(
    path.join(bin, 'tmux'),
    `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(process.env.INSTALLER_TEST_LOG, JSON.stringify({ command: 'tmux', args }) + '\\n');
if (args.length === 1 && args[0] === '-V') {
  process.stdout.write('tmux fixture-version\\n');
  process.exit(0);
}
process.exit(2);
`,
  );
  writeExecutable(
    path.join(bin, 'curl'),
    `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(process.env.INSTALLER_TEST_LOG, JSON.stringify({ command: 'curl', args }) + '\\n');
if (args.includes('--version')) {
  process.stdout.write('curl fixture-version\\n');
  process.exit(0);
}
const url = args.find((arg) => arg.startsWith('http://') || arg.startsWith('https://'));
const match = url && /:(\\d+)\\/health$/u.exec(url);
const allowed = new Set((process.env.INSTALLER_TEST_HEALTH_PORTS || '').split(',').filter(Boolean));
if (match && allowed.has(match[1])) {
  process.stdout.write(JSON.stringify({
    status: 'ok',
    manifest_version: 3,
    build_version: process.env.INSTALLER_TEST_HEALTH_VERSION,
  }) + '\\n');
  process.exit(0);
}
process.exit(22);
`,
  );

  return {
    base,
    fixture,
    home,
    bin,
    evidence,
    temp,
    state,
    defaultPath,
    commandDispatcher,
  };
}

function installerEnv(fixture, { healthPorts = [49181, 49182], extra = {} } = {}) {
  const env = {
    PATH: `${path.join(fixture.home, '.local', 'bin')}:${fixture.bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: fixture.home,
    TMPDIR: fixture.temp,
    TMP: fixture.temp,
    TEMP: fixture.temp,
    LANG: process.env.LANG || 'C.UTF-8',
    LC_ALL: process.env.LC_ALL || 'C.UTF-8',
    USER: process.env.USER || 'installer-test',
    LOGNAME: process.env.LOGNAME || process.env.USER || 'installer-test',
    SHELL: '/bin/bash',
    npm_config_prefix: path.join(fixture.base, 'npm-prefix'),
    npm_config_cache: path.join(fixture.base, 'npm-cache'),
    ROUTECODEX_INSTALL_LOCK_DIR: path.join(fixture.temp, 'install-lifecycle.lock'),
    ROUTECODEX_V3_STATE_DIR: fixture.state,
    CARGO: path.join(fixture.bin, 'cargo'),
    INSTALLER_TEST_LOG: path.join(fixture.evidence, 'commands.jsonl'),
    INSTALLER_TEST_HEALTH_PORTS: healthPorts.join(','),
    INSTALLER_TEST_HEALTH_VERSION: expectedVersion,
    INSTALLER_TEST_COMMAND_VERSION: `rccv3 ${expectedVersion}`,
    ROUTECODEX_INSTALLER_TEST_CONFIG_BINARY: candidateCli,
    INSTALLER_TEST_COMMAND_DISPATCHER: fixture.commandDispatcher,
  };
  return { ...env, ...extra };
}

function runInstaller(fixture, scriptName, envOptions = {}) {
  const runNumber = fs.readdirSync(fixture.evidence)
    .filter((name) => name.startsWith('run-'))
    .length + 1;
  const result = spawnSync(
    '/bin/bash',
    [path.join(fixture.fixture, 'scripts', scriptName)],
    {
      cwd: fixture.fixture,
      env: installerEnv(fixture, envOptions),
      encoding: 'utf8',
      timeout: 2 * 60_000,
    },
  );
  const outputName = `run-${String(runNumber).padStart(2, '0')}-${scriptName}.log`;
  fs.writeFileSync(
    path.join(fixture.evidence, outputName),
    `status=${result.status ?? 'null'}\nsignal=${result.signal ?? ''}\nstdout:\n${result.stdout || ''}\nstderr:\n${result.stderr || ''}\n`,
  );
  return { ...result, outputName };
}

function commandLog(fixture) {
  const logPath = path.join(fixture.evidence, 'commands.jsonl');
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function assertSuccess(result, fixture) {
  assert.equal(
    result.status,
    0,
    `${fixture.evidence}/${result.outputName}\n${result.stdout || ''}\n${result.stderr || ''}`,
  );
}

function assertFailure(result, fixture) {
  assert.notEqual(
    result.status,
    0,
    `${fixture.evidence}/${result.outputName}\n${result.stdout || ''}\n${result.stderr || ''}`,
  );
  assert.doesNotMatch(result.stdout || '', /安装完成|安装成功/u);
}

function restartEntries(logs, command) {
  return logs.filter((entry) => entry.command === command && entry.args?.[0] === 'restart' && !entry.disposition);
}

function configCheckEntries(logs, command = 'rccv3') {
  return logs.filter((entry) => entry.command === command
    && entry.args?.[0] === 'config'
    && entry.args?.[1] === 'check');
}

function forwardedCheckEntries(logs) {
  return logs.filter((entry) => entry.command === 'delegate-config-check');
}

function cleanup(fixture) {
  fs.rmSync(fixture.base, { recursive: true, force: true });
}

test('release installer defaults to config.toml and completes the isolated public flow', () => {
  const fixture = createFixture();
  try {
    const result = runInstaller(fixture, 'install-release.sh', { healthPorts: [49181, 49182] });
    assertSuccess(result, fixture);
    const logs = commandLog(fixture);
    const restarts = restartEntries(logs, 'rcc');
    assert.equal(restarts.length, 1);
    assert.deepEqual(restarts[0].args, ['restart', '-c', fixture.defaultPath]);
    assert.deepEqual(
      forwardedCheckEntries(logs).filter((entry) => entry.status === 0).map((entry) => entry.config),
      [fixture.defaultPath],
    );
    const healthURLs = logs
      .filter((entry) => entry.command === 'curl')
      .flatMap((entry) => entry.args || [])
      .filter((arg) => /:4918[12]\/health$/u.test(arg));
    assert.equal(healthURLs.some((url) => url.endsWith(':49181/health')), true);
    assert.equal(healthURLs.some((url) => url.endsWith(':49182/health')), true);
  } finally {
    cleanup(fixture);
  }
});

test('global installer defaults to config.toml without restart and supports explicit restart', () => {
  const fixture = createFixture();
  try {
    const defaultResult = runInstaller(fixture, 'install-global.sh', { healthPorts: [49181, 49182] });
    assertSuccess(defaultResult, fixture);
    let logs = commandLog(fixture);
    assert.deepEqual(
      configCheckEntries(logs).map((entry) => entry.args),
      [['config', 'check', '-c', fixture.defaultPath]],
    );
    assert.equal(restartEntries(logs, 'routecodex').length, 0);

    const restartResult = runInstaller(fixture, 'install-global.sh', {
      healthPorts: [49181, 49182],
      extra: { ROUTECODEX_BUILD_RESTART_ONLY: '1' },
    });
    assertSuccess(restartResult, fixture);
    logs = commandLog(fixture);
    const restarts = restartEntries(logs, 'routecodex');
    assert.equal(restarts.length, 1);
    assert.deepEqual(restarts[0].args, ['restart', '-c', fixture.defaultPath]);
    const lastCheck = configCheckEntries(logs).at(-1);
    assert.deepEqual(lastCheck.args, ['config', 'check', '-c', fixture.defaultPath]);
    assert.deepEqual(
      forwardedCheckEntries(logs).filter((entry) => entry.status === 0).map((entry) => entry.config).at(-1),
      fixture.defaultPath,
    );
  } finally {
    cleanup(fixture);
  }
});

test('both installers preserve override precedence and quoted paths', () => {
  for (const scriptName of ['install-release.sh', 'install-global.sh']) {
    const fixture = createFixture();
    try {
      const routecodexOverride = path.join(fixture.home, '.rcc', 'override alpha', 'config.toml');
      const rccOverride = path.join(fixture.home, '.rcc', 'override beta', 'config.toml');
      writeValidUserConfig(routecodexOverride, [49183]);
      writeValidUserConfig(rccOverride, [49184]);

      const both = runInstaller(fixture, scriptName, {
        healthPorts: [49181, 49182, 49183, 49184],
        extra: {
          ROUTECODEX_INSTALL_VERIFY_CONFIG: routecodexOverride,
          RCC_INSTALL_VERIFY_CONFIG: rccOverride,
        },
      });
      assertSuccess(both, fixture);
      let logs = commandLog(fixture);
      if (scriptName === 'install-release.sh') {
        assert.deepEqual(restartEntries(logs, 'rcc').at(-1).args, ['restart', '-c', routecodexOverride]);
      } else {
        assert.deepEqual(configCheckEntries(logs).at(-1).args, ['config', 'check', '-c', routecodexOverride]);
      }

      const rccOnly = runInstaller(fixture, scriptName, {
        healthPorts: [49181, 49182, 49183, 49184],
        extra: {
          ROUTECODEX_INSTALL_VERIFY_CONFIG: '',
          RCC_INSTALL_VERIFY_CONFIG: rccOverride,
        },
      });
      assertSuccess(rccOnly, fixture);
      logs = commandLog(fixture);
      if (scriptName === 'install-release.sh') {
        assert.deepEqual(restartEntries(logs, 'rcc').at(-1).args, ['restart', '-c', rccOverride]);
      } else {
        assert.deepEqual(configCheckEntries(logs).at(-1).args, ['config', 'check', '-c', rccOverride]);
      }
    } finally {
      cleanup(fixture);
    }
  }
});

test('missing default or explicit override fails without restart or success claim', () => {
  for (const scriptName of ['install-release.sh', 'install-global.sh']) {
    const fixture = createFixture({ defaultConfig: false });
    try {
      const missingDefault = runInstaller(fixture, scriptName);
      assertFailure(missingDefault, fixture);
      assert.equal(commandLog(fixture).filter((entry) => entry.disposition === 'restart-recorded-not-executed').length, 0);
    } finally {
      cleanup(fixture);
    }

    const overrideFixture = createFixture();
    try {
      const missingOverride = path.join(overrideFixture.home, '.rcc', 'missing override', 'config.toml');
      const result = runInstaller(overrideFixture, scriptName, {
        extra: { ROUTECODEX_INSTALL_VERIFY_CONFIG: missingOverride },
      });
      assertFailure(result, overrideFixture);
      assert.equal(commandLog(overrideFixture).filter((entry) => entry.disposition === 'restart-recorded-not-executed').length, 0);
    } finally {
      cleanup(overrideFixture);
    }
  }
});

test('invalid selected config reaches the real V3 consumer and fails without success claim', () => {
  for (const scriptName of ['install-release.sh', 'install-global.sh']) {
    const fixture = createFixture();
    try {
      const invalidPath = path.join(fixture.home, '.rcc', 'invalid selected', 'config.toml');
      writeInvalidUserConfig(invalidPath);
      const result = runInstaller(fixture, scriptName, {
        healthPorts: [49181],
        extra: { ROUTECODEX_INSTALL_VERIFY_CONFIG: invalidPath },
      });
      assertFailure(result, fixture);
      const logs = commandLog(fixture);
      assert.equal(forwardedCheckEntries(logs).some((entry) => entry.config === invalidPath), true);
      assert.equal(forwardedCheckEntries(logs).every((entry) => entry.status !== 0), true);
      assert.equal(logs.filter((entry) => entry.disposition === 'restart-recorded-not-executed').length, 0);
    } finally {
      cleanup(fixture);
    }
  }
});

test('a valid legacy config does not mask a missing default config.toml', () => {
  for (const scriptName of ['install-release.sh', 'install-global.sh']) {
    const fixture = createFixture({ defaultConfig: false });
    try {
      const legacyPath = path.join(fixture.home, '.rcc', 'config.v3.toml');
      writeLegacyConfig(legacyPath);
      const legacyCheck = spawnSync(candidateCli, ['config', 'check', '-c', legacyPath], {
        env: installerEnv(fixture),
        encoding: 'utf8',
      });
      assert.equal(legacyCheck.status, 0, legacyCheck.stderr || legacyCheck.stdout);

      const result = runInstaller(fixture, scriptName);
      assertFailure(result, fixture);
      const logs = commandLog(fixture);
      assert.equal(
        forwardedCheckEntries(logs).some((entry) => entry.config === legacyPath && entry.status === 0),
        false,
        'a successful legacy compile must not satisfy the missing config.toml default',
      );
    } finally {
      cleanup(fixture);
    }
  }
});
