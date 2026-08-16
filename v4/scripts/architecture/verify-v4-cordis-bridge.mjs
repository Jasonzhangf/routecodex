#!/usr/bin/env node
/**
 * v4_parity_gate_cordis_bridge
 *
 * Locks the M3 Rust bridge boundary before the Node/Cordis host is introduced:
 * 1. one registered module owns the bridge crate and its verification stack;
 * 2. function/mainline maps bind real bridge symbols and both source edges;
 * 3. every Cargo path dependency is registered as a transitional source edge;
 * 4. plan hash and handle registration fail before execution;
 * 5. effect guards keep normal data, control and diagnostics physically split;
 * 6. diagnostic concurrency is deterministic and fails fast on handle errors.
 *
 * Run with --red-self-test to prove every protected class fails closed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const readText = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const readJson = (file) => JSON.parse(readText(file));
const clone = (value) => JSON.parse(JSON.stringify(value));

const MODULE_ID = 'routecodex-v4-cordis-bridge';
const OWNED_PATH = 'crates/routecodex-v4-cordis-bridge/**';
const MANIFEST_PATH = 'crates/routecodex-v4-cordis-bridge/Cargo.toml';
const REQUIRED_GATES = [
  'v4_plugin_bridge_l2_regression',
  'v4_parity_gate_cordis_bridge',
  'v4_parity_gate_cordis_bridge_red',
];
const REQUIRED_DEPENDENCIES = [
  'routecodex-v4-plugin-contract',
  'routecodex-v4-plugin-plan',
];

const DECL_RE = /^(?:pub(?:\([^)]*\))?\s+)?(struct|enum|trait|fn|type|const|static)\s+([A-Za-z_][A-Za-z0-9_]*)\b/gm;
const IMPL_RE = /^[\s]*impl(?:\s*<[^>]*>)?\s+([A-Za-z_][A-Za-z0-9_]*)\b[^{]*\{/gm;
const METHOD_RE = /^[\s]*(?:pub(?:\([^)]*\))?\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\b/gm;

function collectDeclaredSymbols(source) {
  const symbols = new Set();
  for (const match of source.matchAll(DECL_RE)) {
    symbols.add(match[2]);
  }
  for (const implMatch of source.matchAll(IMPL_RE)) {
    const typeName = implMatch[1];
    let depth = 0;
    let index = implMatch.index + implMatch[0].length;
    while (index < source.length) {
      if (source[index] === '{') depth += 1;
      if (source[index] === '}') {
        depth -= 1;
        if (depth < 0) break;
      }
      index += 1;
    }
    const block = source.slice(implMatch.index + implMatch[0].length, index);
    for (const method of block.matchAll(METHOD_RE)) {
      symbols.add(`${typeName}::${method[1]}`);
    }
  }
  return symbols;
}

function hasRegisteredSourceEdge(registry, dependency) {
  return (registry.consumers ?? []).some(
    (entry) =>
      entry.consumer === MODULE_ID &&
      entry.dependency === dependency &&
      entry.mode === 'source_path' &&
      entry.status === 'transitional' &&
      entry.manifest_path === MANIFEST_PATH,
  );
}

function validate(state) {
  const failures = [];
  const gateIds = new Set((state.verificationMap.gates ?? []).map((gate) => gate.gate_id));

  const module = (state.moduleRegistry.modules ?? []).find(
    (entry) => entry.module_id === MODULE_ID,
  );
  if (!module) {
    failures.push(`${MODULE_ID}: missing module-registry entry`);
  } else {
    if (module.status !== 'active') failures.push(`${MODULE_ID}: status must be active`);
    if (module.owner !== MODULE_ID) failures.push(`${MODULE_ID}: owner drifted`);
    if (!(module.owned_paths ?? []).includes(OWNED_PATH)) {
      failures.push(`${MODULE_ID}: missing owned_path ${OWNED_PATH}`);
    }
    for (const gate of REQUIRED_GATES) {
      if (!(module.verification_gates ?? []).includes(gate)) {
        failures.push(`${MODULE_ID}: missing module gate ${gate}`);
      }
    }
  }

  const projectModule = (state.project.modules ?? []).find(
    (entry) => entry.module_id === MODULE_ID,
  );
  if (!projectModule) {
    failures.push(`${MODULE_ID}: missing project module`);
  } else {
    if (projectModule.stage !== 'source_implemented') {
      failures.push(`${MODULE_ID}: stage must be source_implemented`);
    }
    if (!(projectModule.owned_paths ?? []).includes(OWNED_PATH)) {
      failures.push(`${MODULE_ID}: project owned_path missing`);
    }
    for (const dependency of REQUIRED_DEPENDENCIES) {
      if (!(projectModule.dependency_modules ?? []).includes(dependency)) {
        failures.push(`${MODULE_ID}: missing project dependency ${dependency}`);
      }
    }
    if ((projectModule.regression?.minimum_test_count ?? 0) < 5) {
      failures.push(`${MODULE_ID}: regression minimum_test_count must be >= 5`);
    }
    if (
      !(projectModule.regression?.input_paths ?? []).includes(
        'crates/routecodex-v4-cordis-bridge/tests/l2_bridge.rs',
      )
    ) {
      failures.push(`${MODULE_ID}: L2 regression input is not registered`);
    }
  }

  for (const gate of REQUIRED_GATES) {
    if (!gateIds.has(gate)) failures.push(`${MODULE_ID}: unregistered verification gate ${gate}`);
  }

  const functionEntry = (state.functionMap.functions ?? []).find(
    (entry) => entry.function_id === 'v4.plugin.bridge',
  );
  if (!functionEntry) {
    failures.push('v4.plugin.bridge: missing function-map entry');
  } else {
    if (functionEntry.owner !== MODULE_ID) {
      failures.push(`v4.plugin.bridge: owner must be ${MODULE_ID}`);
    }
    const declared = collectDeclaredSymbols(state.source);
    for (const symbol of functionEntry.entry_symbols ?? []) {
      if (!declared.has(symbol)) {
        failures.push(`v4.plugin.bridge: symbol ${symbol} is not declared`);
      }
    }
    for (const gate of REQUIRED_GATES) {
      if (!(functionEntry.required_gates ?? []).includes(gate)) {
        failures.push(`v4.plugin.bridge: missing function gate ${gate}`);
      }
    }
  }

  const expectedEdges = [
    {
      to: 'routecodex-v4-plugin-plan',
      owner: 'routecodex-v4-cordis-bridge::compile_node',
      symbols: ['compile_node_plan', 'NodePluginPlan', 'AuthoringPlugin', 'PlanError'],
    },
    {
      to: 'routecodex-v4-plugin-contract',
      owner: 'routecodex-v4-cordis-bridge::execute_plan',
      symbols: ['PluginEffect', 'ResourceRegistry'],
    },
  ];
  for (const expected of expectedEdges) {
    const edge = (state.mainline.edges ?? []).find(
      (entry) =>
        entry.from === MODULE_ID &&
        entry.to === expected.to &&
        entry.owner === expected.owner &&
        entry.edge_type === 'symbol_dependency' &&
        entry.path === 'crates/routecodex-v4-cordis-bridge/src/lib.rs' &&
        entry.status === 'active',
    );
    if (!edge) {
      failures.push(`${MODULE_ID}: missing mainline edge to ${expected.to}`);
      continue;
    }
    for (const symbol of expected.symbols) {
      if (!(edge.symbols ?? []).includes(symbol)) {
        failures.push(`${MODULE_ID}->${expected.to}: missing symbol ${symbol}`);
      }
    }
  }

  for (const dependency of REQUIRED_DEPENDENCIES) {
    if (!hasRegisteredSourceEdge(state.consumerRegistry, dependency)) {
      failures.push(`${MODULE_ID}: missing source-path registry edge to ${dependency}`);
    }
    const dependencyPattern = new RegExp(
      `^${dependency}\\s*=\\s*\\{[^}]*path\\s*=`,
      'm',
    );
    if (!dependencyPattern.test(state.manifest)) {
      failures.push(`${MODULE_ID}: manifest lost path dependency ${dependency}`);
    }
  }

  if (!state.workspace.includes('"crates/routecodex-v4-cordis-bridge"')) {
    failures.push(`${MODULE_ID}: missing Cargo workspace membership`);
  }
  if (!/if\s+!plan\.verify\(\)/.test(state.source)) {
    failures.push(`${MODULE_ID}: plan hash verification missing`);
  }
  const verifyIndex = state.source.indexOf('if !plan.verify()');
  const dispatchIndex = state.source.indexOf('for entry in &plan.entries');
  if (verifyIndex < 0 || dispatchIndex < 0 || verifyIndex > dispatchIndex) {
    failures.push(`${MODULE_ID}: plan hash is not verified before handle dispatch`);
  }
  if (!/registry\.contains\(&entry\.plugin_id\)/.test(state.source)) {
    failures.push(`${MODULE_ID}: handle preflight registration guard missing`);
  }
  if (!/matches!\(self\.effect,\s*PluginEffect::Semantic\)/s.test(state.source)) {
    failures.push(`${MODULE_ID}: normal-data write guard missing`);
  }
  if (
    !/PluginEffect::Semantic\s*\|\s*PluginEffect::ControlOnly/.test(state.source)
  ) {
    failures.push(`${MODULE_ID}: control write guard missing`);
  }
  for (const field of ['data', 'control']) {
    if (!new RegExp(`pub ${field}: Value`).test(state.source)) {
      failures.push(`${MODULE_ID}: typed ${field} field missing`);
    }
  }
  if (/pub\s+metadata\s*:/.test(state.source)) {
    failures.push(`${MODULE_ID}: generic metadata field entered bridge payload`);
  }
  if (!/std::thread::scope/.test(state.source)) {
    failures.push(`${MODULE_ID}: diagnostic concurrency owner missing`);
  }
  if (!/outcomes\.sort_by_key/.test(state.source)) {
    failures.push(`${MODULE_ID}: diagnostic output order is nondeterministic`);
  }
  if (!/Err\(message\)\s*=>\s*Err\(BridgeError::HandleError/s.test(state.source)) {
    failures.push(`${MODULE_ID}: diagnostic handle failure is not fail-fast`);
  }
  if (/node\.(diagnostic_error|unregistered_handle)/.test(state.source)) {
    failures.push(`${MODULE_ID}: diagnostic failure was softened into a fact`);
  }

  const tests = state.tests.match(/#\[test\]/g)?.length ?? 0;
  if (tests < 5) failures.push(`${MODULE_ID}: expected >= 5 L2 tests, got ${tests}`);
  for (const testName of [
    'ordered_serial_execution_in_plan_order_with_read_only_observer',
    'control_only_plugin_writes_control_never_normal_data',
    'tampered_plan_hash_is_rejected_before_handles_run',
    'unregistered_handle_fails_fast',
    'read_only_handle_cannot_write_normal_data',
  ]) {
    if (!state.tests.includes(`fn ${testName}()`)) {
      failures.push(`${MODULE_ID}: missing L2 test ${testName}`);
    }
  }

  return failures;
}

function loadState() {
  return {
    moduleRegistry: readJson('.appsdk/maps/module-registry.json'),
    project: readJson('.appsdk/project.json'),
    verificationMap: readJson('.appsdk/maps/verification-map.json'),
    functionMap: readJson('.appsdk/maps/function-map.json'),
    mainline: readJson('.appsdk/maps/mainline-call-map.json'),
    consumerRegistry: readJson('contracts/active-link/frozen-consumer-registry.json'),
    source: readText('crates/routecodex-v4-cordis-bridge/src/lib.rs'),
    tests: readText('crates/routecodex-v4-cordis-bridge/tests/l2_bridge.rs'),
    manifest: readText(MANIFEST_PATH),
    workspace: readText('Cargo.toml'),
  };
}

function cloneState(state) {
  return {
    moduleRegistry: clone(state.moduleRegistry),
    project: clone(state.project),
    verificationMap: clone(state.verificationMap),
    functionMap: clone(state.functionMap),
    mainline: clone(state.mainline),
    consumerRegistry: clone(state.consumerRegistry),
    source: state.source,
    tests: state.tests,
    manifest: state.manifest,
    workspace: state.workspace,
  };
}

function runSelfTest() {
  const baseline = loadState();
  const cases = [
    ['module registry entry missing', (state) => {
      state.moduleRegistry.modules = state.moduleRegistry.modules.filter(
        (entry) => entry.module_id !== MODULE_ID,
      );
    }],
    ['project stage downgraded', (state) => {
      state.project.modules.find((entry) => entry.module_id === MODULE_ID).stage = 'design';
    }],
    ['verification gate missing', (state) => {
      state.verificationMap.gates = state.verificationMap.gates.filter(
        (entry) => entry.gate_id !== 'v4_plugin_bridge_l2_regression',
      );
    }],
    ['function symbol ghosted', (state) => {
      state.functionMap.functions.find(
        (entry) => entry.function_id === 'v4.plugin.bridge',
      ).entry_symbols = ['GhostSymbol'];
    }],
    ['plugin-plan mainline edge missing', (state) => {
      state.mainline.edges = state.mainline.edges.filter(
        (entry) => !(entry.from === MODULE_ID && entry.to === 'routecodex-v4-plugin-plan'),
      );
    }],
    ['source-path dependency unregistered', (state) => {
      state.consumerRegistry.consumers = state.consumerRegistry.consumers.filter(
        (entry) => !(entry.consumer === MODULE_ID && entry.dependency === 'routecodex-v4-plugin-contract'),
      );
    }],
    ['plan verification removed', (state) => {
      state.source = state.source.replace('if !plan.verify()', 'if false');
    }],
    ['normal-data guard widened', (state) => {
      state.source = state.source.replace(
        'matches!(self.effect, PluginEffect::Semantic)',
        'matches!(self.effect, PluginEffect::Semantic | PluginEffect::ReadOnly)',
      );
    }],
    ['diagnostic order removed', (state) => {
      state.source = state.source.replace('outcomes.sort_by_key', 'outcomes.iter_mut');
    }],
    ['diagnostic failure softened', (state) => {
      state.source = state.source.replace(
        'Err(message) => Err(BridgeError::HandleError',
        'Err(message) => Ok(vec![DiagnosticFact',
      );
    }],
  ];

  let missed = 0;
  for (const [name, mutate] of cases) {
    const state = cloneState(baseline);
    mutate(state);
    const failures = validate(state);
    if (failures.length === 0) {
      console.error(`[v4_parity_gate_cordis_bridge] red self-test ${name}: expected FAIL, got PASS`);
      missed += 1;
    } else {
      console.log(`[v4_parity_gate_cordis_bridge] red self-test ${name}: FAIL as expected (${failures.length})`);
    }
  }
  if (missed > 0) process.exit(1);
  console.log('[v4_parity_gate_cordis_bridge] OK red self-test 10/10');
}

if (process.argv.includes('--red-self-test')) {
  runSelfTest();
} else {
  const failures = validate(loadState());
  if (failures.length > 0) {
    console.error('[v4_parity_gate_cordis_bridge] FAIL');
    console.error(failures.join('\n'));
    process.exit(1);
  }
  console.log('[v4_parity_gate_cordis_bridge] OK bridge module/effects/hash/fail-fast bound');
}
