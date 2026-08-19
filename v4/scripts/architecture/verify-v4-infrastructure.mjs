#!/usr/bin/env node
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const readJson = (relative) => JSON.parse(read(relative));

function validate(input) {
  const failures = [];
  const moduleIds = new Set(input.modules.modules.map((entry) => entry.module_id));
  const functionIds = new Set(input.functions.functions.map((entry) => entry.function_id));
  const resourceIds = new Set(input.resources.resources.map((entry) => entry.resource_id));
  const gateIds = new Set(input.verification.gates.map((entry) => entry.gate_id));

  for (const moduleId of ['routecodex-v4-cli', 'routecodex-v4-lifecycle', 'routecodex-v4-servertool']) {
    if (!moduleIds.has(moduleId)) failures.push(`module registry missing ${moduleId}`);
  }
  for (const functionId of [
    'v4.cli.command_dispatch',
    'v4.config.runtime_manifest',
    'v4.lifecycle.managed_instance',
    'v4.servertool.cli_projection',
    'v4.build_link.build_binary',
    'v4.runtime.binary_cold_start',
  ]) {
    if (!functionIds.has(functionId)) failures.push(`function map missing ${functionId}`);
  }
  for (const resourceId of [
    'v4.cli.command_intent',
    'v4.lifecycle.instance_state',
    'v4.lifecycle.control_socket',
    'v4.servertool.cli_projection',
    'v4.servertool.cli_control',
    'v4.runtime.compiled_manifest',
  ]) {
    if (!resourceIds.has(resourceId)) failures.push(`resource map missing ${resourceId}`);
  }
  for (const gateId of [
    'v4_cli_l2_regression',
    'v4_lifecycle_l2_regression',
    'v4_infrastructure_contract',
    'v4_infrastructure_contract_red',
    'v4_runtime_bin_l2_regression',
    'v4_servertool_l2_regression',
  ]) {
    if (!gateIds.has(gateId)) failures.push(`verification map missing ${gateId}`);
  }

  if (!input.cargo.includes('"crates/routecodex-v4-cli"')) failures.push('workspace missing routecodex-v4-cli');
  if (!input.cargo.includes('"crates/routecodex-v4-lifecycle"')) failures.push('workspace missing routecodex-v4-lifecycle');
  if (!input.cargo.includes('"crates/routecodex-v4-servertool"')) failures.push('workspace missing routecodex-v4-servertool');
  if (!input.runtimeBin.includes('routecodex_v4_cli')) failures.push('runtime-bin does not dispatch typed CLI intents');
  if (!input.runtimeBin.includes('routecodex_v4_lifecycle')) failures.push('runtime-bin does not delegate managed lifecycle');
  if (!input.runtimeBin.includes('routecodex_v4_servertool')) failures.push('runtime-bin does not delegate servertool projection');
  if (input.runtimeBin.includes('DEFAULT_MANIFEST')) failures.push('runtime-bin retains cwd-relative default manifest');
  if (input.runtimeBin.includes('AdmissionHandler')) failures.push('runtime-bin retains admission handler bypass');
  if (!input.config.includes('RuntimeConfigManifest')) failures.push('config owner lacks operational runtime manifest');
  if (!input.lifecycle.includes('V4LifecyclePaths')) failures.push('lifecycle owner lacks V4-isolated paths');
  if (!input.lifecycle.includes('exec_managed_restart')) failures.push('lifecycle owner lacks exec restart');
  if (!input.server.includes('V4HttpServer')) failures.push('server owner lacks managed listener type');
  if (!input.packageJson.includes('"install:global"')) failures.push('package scripts do not expose global V4 install');
  if (!input.installer.includes("path.join(os.homedir(), '.local/bin')")) failures.push('installer does not own the global rccv4 path');
  if (!input.installer.includes("'/usr/bin/codesign'")) failures.push('installer does not codesign the global Mach-O');
  if (!input.installer.includes('installed hash drift')) failures.push('installer does not verify installed hash identity');
  if (!input.servertool.includes('ServertoolRunControl')) failures.push('servertool owner lacks typed control side-channel');
  if (/pub struct ServertoolRunOutput\s*\{[^}]*(?:route_hint|flow_id|session_id|request_id)/.test(input.servertool)) {
    failures.push('servertool business output contains control fields');
  }
  if (!input.buildLink.includes('.env("CARGO_PKG_VERSION", package_version)')) {
    failures.push('Active binary build does not bind the consumer package version');
  }

  const gateById = new Map(input.verification.gates.map((entry) => [entry.gate_id, entry]));
  for (const gateId of [
    'v4_real_runtime_compiled_manifest',
    'v4_real_runtime_provider_transport',
    'v4_real_runtime_server_http',
  ]) {
    const command = gateById.get(gateId)?.command ?? '';
    if (!command.includes('routecodex-v4-build-link -- test-consumer')) {
      failures.push(`${gateId} does not execute through Active build-link`);
    }
  }
  if (!gateById.get('v4_runtime_bin_l2_regression')?.command.includes('routecodex-v4-build-link -- test-binary')) {
    failures.push('runtime-bin blackbox gate does not execute through Active build-link');
  }

  const production = [input.cli, input.config, input.lifecycle, input.runtimeBin, input.server].join('\n');
  if (/127\.0\.0\.1:(?:5520|5521|17777)/.test(production)) failures.push('production source hardcodes a listener port');
  if (/process\.kill|killall|pkill/.test(production)) failures.push('production lifecycle uses process killing instead of control socket');
  return failures;
}

const input = {
  modules: readJson('.appsdk/maps/module-registry.json'),
  functions: readJson('.appsdk/maps/function-map.json'),
  resources: readJson('.appsdk/maps/resource-map.json'),
  verification: readJson('.appsdk/maps/verification-map.json'),
  cargo: read('Cargo.toml'),
  cli: fs.existsSync(path.join(root, 'crates/routecodex-v4-cli/src/lib.rs')) ? read('crates/routecodex-v4-cli/src/lib.rs') : '',
  config: read('crates/routecodex-v4-config/src/lib.rs'),
  lifecycle: fs.existsSync(path.join(root, 'crates/routecodex-v4-lifecycle/src/lib.rs')) ? read('crates/routecodex-v4-lifecycle/src/lib.rs') : '',
  runtimeBin: read('crates/routecodex-v4-runtime-bin/src/main.rs'),
  server: read('crates/routecodex-v4-server/src/lib.rs'),
  packageJson: read('package.json'),
  installer: read('scripts/install-rccv4.mjs'),
  servertool: read('crates/routecodex-v4-servertool/src/lib.rs'),
  buildLink: read('crates/routecodex-v4-build-link/src/main.rs'),
};

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

function runBinary(binary, args, options = {}) {
  const result = spawnSync(binary, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    timeout: 20000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${args.join(' ')} failed: ${result.error?.message ?? result.stderr}`);
  }
  return result.stdout;
}

async function verifyRuntimeBinary() {
  const binary = path.join(root, 'target/release/rccv4');
  if (!fs.existsSync(binary)) throw new Error(`runtime binary missing: ${binary}`);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rccv4-infrastructure-'));
  const config = path.join(tempRoot, 'config.v4.toml');
  const stateRoot = path.join(tempRoot, 'state');
  const port = await reservePort();
  const env = { ...process.env, RCCV4_STATE_ROOT: stateRoot };
  let started = false;
  try {
    runBinary(binary, ['--version'], { cwd: tempRoot, env });
    runBinary(binary, ['--help'], { cwd: tempRoot, env });
    runBinary(binary, [
      'init', '-c', config,
      '--provider', 'blackbox-provider',
      '--base-url', 'https://example.invalid/v1',
      '--model', 'blackbox-model',
      '--api-key', 'blackbox-test-only',
      '--port', String(port),
    ], { cwd: tempRoot, env });
    runBinary(binary, ['config', 'check', '-c', config], { cwd: tempRoot, env });
    const tool = JSON.parse(runBinary(binary, [
      'servertool', 'run', 'web_search', '--input-json', '{"query":"RouteCodex"}',
      '--flow', 'flow-1', '--session-id', 'session-1', '--request-id', 'request-1',
    ], { cwd: tempRoot, env }));
    for (const field of ['routeHint', 'flowId', 'sessionId', 'requestId']) {
      if (Object.hasOwn(tool, field)) throw new Error(`servertool output leaked ${field}`);
    }
    runBinary(binary, ['start', '-c', config, '--snap'], { cwd: tempRoot, env });
    started = true;
    const status = runBinary(binary, ['status', '-c', config], { cwd: tempRoot, env });
    if (!status.includes('state=running')) throw new Error(`unexpected status: ${status}`);
    runBinary(binary, ['restart', '-c', config], { cwd: tempRoot, env });
    runBinary(binary, ['stop', '-c', config], { cwd: tempRoot, env });
    started = false;
  } finally {
    if (started) {
      const stop = spawnSync(binary, ['stop', '-c', config], {
        cwd: tempRoot,
        env,
        encoding: 'utf8',
        timeout: 20000,
      });
      if (stop.error || stop.status !== 0) {
        throw new Error(`cleanup stop failed: ${stop.error?.message ?? stop.stderr}`);
      }
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

if (process.argv.includes('--red-self-test')) {
  const mutated = structuredClone(input);
  mutated.runtimeBin += '\nconst DEFAULT_MANIFEST: &str = "generated/manifest.json";\n';
  const failures = validate(mutated);
  if (!failures.includes('runtime-bin retains cwd-relative default manifest')) {
    console.error('[v4_infrastructure] red self-test failed to detect cwd-relative manifest');
    process.exit(1);
  }
  const controlLeak = structuredClone(input);
  controlLeak.servertool = controlLeak.servertool.replace(
    'pub struct ServertoolRunOutput {',
    'pub struct ServertoolRunOutput {\n    pub route_hint: String,',
  );
  if (!validate(controlLeak).includes('servertool business output contains control fields')) {
    console.error('[v4_infrastructure] red self-test failed to detect servertool control leakage');
    process.exit(1);
  }
  const versionLeak = structuredClone(input);
  versionLeak.buildLink = versionLeak.buildLink.replace(
    '.env("CARGO_PKG_VERSION", package_version)',
    '',
  );
  if (!validate(versionLeak).includes('Active binary build does not bind the consumer package version')) {
    console.error('[v4_infrastructure] red self-test failed to detect inherited binary version');
    process.exit(1);
  }
  const invalidRuntimeGate = structuredClone(input);
  invalidRuntimeGate.verification.gates.find(
    (gate) => gate.gate_id === 'v4_runtime_bin_l2_regression',
  ).command = 'cargo test -p routecodex-v4-runtime-bin --test l2_cli_blackbox';
  if (!validate(invalidRuntimeGate).includes('runtime-bin blackbox gate does not execute through Active build-link')) {
    console.error('[v4_infrastructure] red self-test failed to detect bypassed runtime-bin gate');
    process.exit(1);
  }
  console.log('[v4_infrastructure] red self-test OK');
  process.exit(0);
}

const failures = validate(input);
if (failures.length > 0) {
  console.error('[v4_infrastructure] FAIL');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
await verifyRuntimeBinary();
console.log('[v4_infrastructure] PASS');
