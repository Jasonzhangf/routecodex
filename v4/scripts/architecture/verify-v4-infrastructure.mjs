#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
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
    'v4.runtime.binary_cold_start',
  ]) {
    if (!functionIds.has(functionId)) failures.push(`function map missing ${functionId}`);
  }
  for (const resourceId of [
    'v4.cli.command_intent',
    'v4.lifecycle.instance_state',
    'v4.lifecycle.control_socket',
    'v4.servertool.cli_projection',
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
};

if (process.argv.includes('--red-self-test')) {
  const mutated = structuredClone(input);
  mutated.runtimeBin += '\nconst DEFAULT_MANIFEST: &str = "generated/manifest.json";\n';
  const failures = validate(mutated);
  if (!failures.includes('runtime-bin retains cwd-relative default manifest')) {
    console.error('[v4_infrastructure] red self-test failed to detect cwd-relative manifest');
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
console.log('[v4_infrastructure] PASS');
