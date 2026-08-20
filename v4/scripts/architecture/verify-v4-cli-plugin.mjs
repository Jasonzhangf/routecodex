#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(new URL('.', import.meta.url).pathname, '..', '..');
const sourcePath = path.join(root, 'crates/routecodex-v4-cli-plugin/src/main.rs');
const contractPath = path.join(root, 'contracts/cli-plugin.contract.json');
const moduleRegistryPath = path.join(root, '.appsdk/maps/module-registry.json');
const functionMapPath = path.join(root, '.appsdk/maps/function-map.json');
const verificationMapPath = path.join(root, '.appsdk/maps/verification-map.json');
const red = process.argv.includes('--red-self-test');

const source = fs.readFileSync(sourcePath, 'utf8');
const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
const moduleRegistry = JSON.parse(fs.readFileSync(moduleRegistryPath, 'utf8'));
const functionMap = JSON.parse(fs.readFileSync(functionMapPath, 'utf8'));
const verificationMap = JSON.parse(fs.readFileSync(verificationMapPath, 'utf8'));
const requiredSymbols = [
  'struct Cli',
  'enum Command',
  'fn run()',
  'standard_plugins()',
  'standard_resource_registry()',
  'standard_node_allowed_reads',
  'standard_node_allowed_writes',
];
const forbidden = [
  'std::fs',
  'Command::Start',
  'Command::Restart',
  'Command::Stop',
  'std::process::Command',
];

function validate(candidate = source) {
  const failures = [];
  for (const symbol of requiredSymbols) {
    if (!candidate.includes(symbol)) failures.push(`missing symbol: ${symbol}`);
  }
  for (const token of forbidden) {
    if (candidate.includes(token)) failures.push(`forbidden runtime access: ${token}`);
  }
  if (contract.status !== 'contract_bound') failures.push('CLI contract is not contract_bound');
  if (contract.owner_feature_id !== 'v4.plugin.cli_inspector') {
    failures.push('CLI contract owner feature drifted');
  }
  const module = (moduleRegistry.modules ?? []).find(
    (entry) => entry.module_id === 'routecodex-v4-cli-plugin',
  );
  if (!module || module.status !== 'active' || !module.owned_paths?.includes('crates/routecodex-v4-cli-plugin/**')) {
    failures.push('CLI module registry binding missing');
  }
  const fn = (functionMap.functions ?? []).find(
    (entry) => entry.function_id === 'v4.plugin.cli_inspector',
  );
  if (!fn || fn.owner !== 'routecodex-v4-cli-plugin') failures.push('CLI function-map binding missing');
  const gates = new Set((verificationMap.gates ?? []).map((entry) => entry.gate_id));
  for (const gate of ['v4_cli_plugin_l2_regression', 'v4_parity_gate_cli_plugin', 'v4_parity_gate_cli_plugin_red']) {
    if (!gates.has(gate)) failures.push(`CLI verification gate missing: ${gate}`);
  }
  return failures;
}

if (red) {
  const failures = validate(source.replaceAll('standard_plugins', 'missing_plugins'));
  if (failures.length === 0) {
    console.error('[v4 cli plugin red] expected FAIL, got PASS');
    process.exit(1);
  }
  console.log(`[v4 cli plugin red] FAIL as expected (${failures.length})`);
  process.exit(0);
}

const failures = validate();
if (failures.length > 0) {
  console.error(`[v4_parity_gate_cli_plugin] FAIL\n${failures.join('\n')}`);
  process.exit(1);
}
console.log('[v4_parity_gate_cli_plugin] OK CLI module bound');
