#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

const root = path.resolve(new URL('.', import.meta.url).pathname, '..', '..');
const sourcePath = path.join(root, 'crates/routecodex-v4-cli-plugin/src/lib.rs');
const contractPath = path.join(root, 'contracts/cli-plugin.contract.json');
const moduleRegistryPath = path.join(root, '.appsdk/maps/module-registry.json');
const projectPath = path.join(root, '.appsdk/project.json');
const functionMapPath = path.join(root, '.appsdk/maps/function-map.json');
const verificationMapPath = path.join(root, '.appsdk/maps/verification-map.json');
const resourceMapPath = path.join(root, '.appsdk/maps/resource-map.json');
const resourceOperationMapPath = path.join(root, 'docs/architecture/v4-resource-operation-map.yml');
const mainlineCallMapPath = path.join(root, '.appsdk/maps/mainline-call-map.json');
const red = process.argv.includes('--red-self-test');

const source = fs.readFileSync(sourcePath, 'utf8');
const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
const moduleRegistry = JSON.parse(fs.readFileSync(moduleRegistryPath, 'utf8'));
const project = JSON.parse(fs.readFileSync(projectPath, 'utf8'));
const functionMap = JSON.parse(fs.readFileSync(functionMapPath, 'utf8'));
const verificationMap = JSON.parse(fs.readFileSync(verificationMapPath, 'utf8'));
const resourceMap = JSON.parse(fs.readFileSync(resourceMapPath, 'utf8'));
const resourceOperationMap = yaml.load(fs.readFileSync(resourceOperationMapPath, 'utf8'));
const mainlineCallMap = JSON.parse(fs.readFileSync(mainlineCallMapPath, 'utf8'));
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
  const projectModule = (project.modules ?? []).find(
    (entry) => entry.module_id === 'routecodex-v4-cli-plugin',
  );
  if (!module || module.status !== 'active' || !module.owned_paths?.includes('crates/routecodex-v4-cli-plugin/**')) {
    failures.push('CLI module registry binding missing');
  }
  if (!projectModule?.artifact_paths?.includes('bin/rccv4-plugin')) {
    failures.push('CLI module artifact path must be bin/rccv4-plugin');
  }
  if (!projectModule?.generated_outputs?.includes('generated/modules/routecodex-v4-cli-plugin/**')) {
    failures.push('CLI generated output path drifted');
  }
  const buildText = [projectModule?.build?.program, ...(projectModule?.build?.args ?? [])].join(' ');
  if (!buildText.includes('cargo build --release') || !buildText.includes('target/release/rccv4-plugin')) {
    failures.push('CLI build must produce and copy target/release/rccv4-plugin');
  }
  const regressionText = [
    projectModule?.regression?.command?.program,
    ...(projectModule?.regression?.command?.args ?? []),
  ].join(' ');
  if (!regressionText.includes('cargo test --manifest-path Cargo.toml -p routecodex-v4-cli-plugin --locked')) {
    failures.push('CLI regression must retain locked unit tests');
  }
  if (!regressionText.includes('cargo build --release --manifest-path Cargo.toml -p routecodex-v4-cli-plugin --locked')) {
    failures.push('CLI regression must build the release artifact');
  }
  if (!regressionText.includes('node scripts/test-cli-plugin.mjs')) {
    failures.push('CLI regression must execute release artifact smoke tests');
  }
  if (!(projectModule?.regression?.input_paths ?? []).includes('scripts/test-cli-plugin.mjs')) {
    failures.push('CLI smoke test must be a declared regression input');
  }
  const fn = (functionMap.functions ?? []).find(
    (entry) => entry.function_id === 'v4.plugin.cli_inspector',
  );
  if (!fn || fn.owner !== 'routecodex-v4-cli-plugin') failures.push('CLI function-map binding missing');
  if (!fn?.resource_bindings?.includes('v4.cli.standard_library_projection')) {
    failures.push('CLI function resource binding missing');
  }
  const appsdkResource = (resourceMap.resources ?? []).find(
    (entry) => entry.resource_id === 'v4.cli.standard_library_projection',
  );
  if (
    !appsdkResource
    || appsdkResource.status !== 'active'
    || appsdkResource.owner !== 'routecodex-v4-cli-plugin::run'
    || !appsdkResource.allowed_operations?.includes('read')
    || appsdkResource.allowed_operations?.includes('write')
  ) {
    failures.push('CLI readonly projection resource binding missing or writable');
  }
  const yamlResource = (resourceOperationMap.resources ?? []).find(
    (entry) => entry.resource_id === 'v4.cli.standard_library_projection',
  );
  if (
    !yamlResource
    || yamlResource.binding_status !== 'anchored'
    || yamlResource.owner_crate !== 'routecodex-v4-cli-plugin'
    || yamlResource.owner_node !== 'V4CliStandardLibraryProjection'
    || !yamlResource.owner_symbols?.includes('run')
    || !yamlResource.verification_gate?.includes('v4_parity_gate_cli_plugin')
  ) {
    failures.push('CLI resource-operation binding missing or drifted');
  }
  const cliEdge = (mainlineCallMap.edges ?? []).find(
    (edge) => edge.from === 'routecodex-v4-cli-plugin' && edge.to === 'routecodex-v4-standard-plugins',
  );
  if (
    !cliEdge
    || cliEdge.edge_type !== 'readonly_projection'
    || cliEdge.resource !== 'v4.cli.standard_library_projection'
    || cliEdge.owner !== 'routecodex-v4-cli-plugin::run'
  ) {
    failures.push('CLI mainline readonly projection edge missing or drifted');
  }
  for (const doc of contract.canonical_docs ?? []) {
    if (!fs.existsSync(path.join(root, '..', doc))) failures.push(`CLI canonical doc missing: ${doc}`);
  }
  const gates = new Set((verificationMap.gates ?? []).map((entry) => entry.gate_id));
  for (const gate of ['v4_cli_plugin_l2_regression', 'v4_parity_gate_cli_plugin', 'v4_parity_gate_cli_plugin_red']) {
    if (!gates.has(gate)) failures.push(`CLI verification gate missing: ${gate}`);
  }
  return failures;
}

if (red) {
  const cases = [
    ['source symbol removed', () => validate(source.replaceAll('standard_plugins', 'missing_plugins'))],
  ];
  const resourceCase = JSON.parse(JSON.stringify(functionMap));
  resourceCase.functions = resourceCase.functions.filter(
    (entry) => entry.function_id !== 'v4.plugin.cli_inspector',
  );
  const originalFunctionMap = functionMap.functions;
  functionMap.functions = resourceCase.functions;
  cases.push(['function resource binding removed', () => validate(source)]);
  const results = cases.map(([label, check]) => [label, check()]);
  functionMap.functions = originalFunctionMap;
  const failed = results.filter(([, result]) => result.length > 0);
  if (failed.length !== results.length) {
    console.error('[v4 cli plugin red] expected every mutation to FAIL');
    process.exit(1);
  }
  console.log(`[v4 cli plugin red] FAIL as expected (${failed.length}/${results.length})`);
  process.exit(0);
}

const failures = validate();
if (failures.length > 0) {
  console.error(`[v4_parity_gate_cli_plugin] FAIL\n${failures.join('\n')}`);
  process.exit(1);
}
console.log('[v4_parity_gate_cli_plugin] OK CLI module bound');
