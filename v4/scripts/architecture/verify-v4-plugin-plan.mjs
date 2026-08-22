#!/usr/bin/env node
/**
 * v4_parity_gate_plugin_plan
 *
 * Locks the V4 NodePlugin/NodeContainer/Catalog contract and module
 * registration truth for the plugin framework (M1/M2):
 * 1. node-plugin / node-container / plugin-catalog contracts stay
 *    contract_bound with the ordering, selection, resource, effect, failure,
 *    service and snapshot rules intact.
 * 2. routecodex-v4-plugin-contract / -plan / -catalog are registered in the
 *    module registry with owned_paths and registered verification gates.
 * 3. The function map binds real declared Rust symbols for the three plugin
 *    functions.
 * 4. The plugin resources remain contract_bound in the .appsdk resource map
 *    (contract-bound plugin resources are a registered exception and are not
 *    promoted to active before the plugin runtime node exists).
 *
 * Run with --red-self-test to prove the gate fails on each negative class.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const readJson = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const clone = (value) => JSON.parse(JSON.stringify(value));

const CONTRACT_IDS = ['v4-node-plugin', 'v4-node-container', 'v4-plugin-catalog'];
const CONTRACT_RULES = {
  'v4-node-plugin': [
    'ordering_rule',
    'selection_group_rule',
    'resource_rule',
    'effect_rule',
    'failure_rule',
    'service_rule',
  ],
  'v4-node-container': ['ordering_rule', 'selection_rule', 'hash_rule', 'single_plan_rule'],
  'v4-plugin-catalog': [
    'registration_rule',
    'owner_rule',
    'hash_rule',
    'dependency_rule',
    'snapshot_rule',
  ],
};

const MODULES = [
  {
    module_id: 'routecodex-v4-plugin-contract',
    owned_paths: ['crates/routecodex-v4-plugin-contract/**'],
    gates: ['v4_plugin_contract_l2_regression', 'v4_parity_gate_plugin_plan'],
  },
  {
    module_id: 'routecodex-v4-plugin-plan',
    owned_paths: ['crates/routecodex-v4-plugin-plan/**'],
    gates: [
      'v4_plugin_plan_l2_regression',
      'v4_parity_gate_plugin_plan',
      'v4_parity_gate_plugin_plan_red',
    ],
  },
  {
    module_id: 'routecodex-v4-plugin-catalog',
    owned_paths: ['crates/routecodex-v4-plugin-catalog/**'],
    gates: ['v4_plugin_catalog_l2_regression', 'v4_parity_gate_plugin_plan'],
  },
];

const FUNCTIONS = {
  'v4.plugin.contract': 'routecodex-v4-plugin-contract',
  'v4.plugin.plan': 'routecodex-v4-plugin-plan',
  'v4.plugin.catalog': 'routecodex-v4-plugin-catalog',
};

const PLUGIN_RESOURCES = [
  'v4.plugin.node_plugin_contract',
  'v4.plugin.catalog',
  'v4.plugin.node_plugin_plan',
];

// Only crate-level declarations bind a symbol: column-0 `pub [item]` and
// `pub use` re-exports. Impl methods bind as `Type::method` so function-map
// entries follow the existing Rust symbol convention.
const DECL_RE = /^(?:pub(?:\([^)]*\))?\s+)?(struct|enum|trait|fn|type|const|static)\s+([A-Za-z_][A-Za-z0-9_]*)\b/gm;
const IMPL_RE = /^[\s]*impl(?:\s*<[^>]*>)?\s+([A-Za-z_][A-Za-z0-9_]*)\b[^{]*\{/gm;
const METHOD_RE = /^[\s]*(?:pub(?:\([^)]*\))?\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\b/gm;

function collectDeclaredSymbols(crate) {
  const crateRoot = path.join(root, 'crates', crate, 'src');
  const symbols = new Set();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.rs')) {
        const source = fs.readFileSync(full, 'utf8');
        for (const match of source.matchAll(DECL_RE)) {
          if (match[2]) symbols.add(match[2]);
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
            if (method[1]) symbols.add(`${typeName}::${method[1]}`);
          }
        }
      }
    }
  };
  walk(crateRoot);
  return symbols;
}

function validate(contracts, moduleRegistry, verificationMap, functionMap, resourceMap) {
  const failures = [];
  const gateIds = new Set((verificationMap.gates ?? []).map((gate) => gate.gate_id));
  const declared = new Map(
    MODULES.map(({ module_id }) => [module_id, collectDeclaredSymbols(module_id)]),
  );

  for (const contractId of CONTRACT_IDS) {
    const contract = contracts[contractId];
    if (!contract) {
      failures.push(`${contractId}: missing contract`);
      continue;
    }
    if (contract.status !== 'contract_bound') {
      failures.push(`${contractId}: status must be contract_bound (got ${contract.status})`);
    }
    for (const rule of CONTRACT_RULES[contractId]) {
      if (contract[rule] === undefined) {
        failures.push(`${contractId}: missing rule ${rule}`);
      }
    }
    const requiredSemantics = {
      'v4-node-plugin': [
        ['ordering_rule', /phase|tie|cycle/],
        ['selection_group_rule', /exactly one/],
        ['resource_rule', /unauthorized|reject/],
        ['effect_rule', /diagnostic|read_only|control_only/],
        ['failure_rule', /error|fallback/],
        ['service_rule', /own node container|inject/],
      ],
      'v4-node-container': [
        ['ordering_rule', /tie|cycle/],
        ['selection_rule', /exactly one/],
        ['hash_rule', /sha256|canonical/],
        ['single_plan_rule', /one immutable|single/],
      ],
      'v4-plugin-catalog': [
        ['registration_rule', /idempotent/],
        ['owner_rule', /one owner|exactly one/],
        ['hash_rule', /mismatch|rejected/],
        ['dependency_rule', /cycle|missing/],
        ['snapshot_rule', /read-only|immutable/],
      ],
    };
    for (const [rule, pattern] of requiredSemantics[contractId] ?? []) {
      const raw = contract[rule];
      const value =
        typeof raw === 'string' ? raw : JSON.stringify(raw ?? '');
      if (!pattern.test(value)) {
        failures.push(`${contractId}: ${rule} lost required semantics (${value.slice(0, 80)})`);
      }
    }
  }

  const registryModules = new Map(
    (moduleRegistry.modules ?? []).map((module) => [module.module_id, module]),
  );
  for (const expected of MODULES) {
    const module = registryModules.get(expected.module_id);
    if (!module) {
      failures.push(`${expected.module_id}: not registered in module registry`);
      continue;
    }
    for (const ownedPath of expected.owned_paths) {
      if (!(module.owned_paths ?? []).includes(ownedPath)) {
        failures.push(`${expected.module_id}: missing owned_path ${ownedPath}`);
      }
    }
    for (const gate of expected.gates) {
      if (!(module.verification_gates ?? []).includes(gate)) {
        failures.push(`${expected.module_id}: missing verification gate ${gate}`);
      }
      if (!gateIds.has(gate)) {
        failures.push(`${expected.module_id}: gate ${gate} not registered in verification-map`);
      }
    }
  }

  const functions = functionMap.functions ?? [];
  for (const [functionId, owner] of Object.entries(FUNCTIONS)) {
    const entry = functions.find((candidate) => candidate.function_id === functionId);
    if (!entry) {
      failures.push(`${functionId}: missing function-map entry`);
      continue;
    }
    if (entry.owner !== owner) {
      failures.push(`${functionId}: owner must be ${owner} (got ${entry.owner})`);
    }
    const symbols = entry.entry_symbols ?? [];
    const present = declared.get(owner) ?? new Set();
    for (const symbol of symbols) {
      if (!present.has(symbol)) {
        failures.push(`${functionId}: symbol ${symbol} not declared in ${owner} src`);
      }
    }
  }

  const resources = resourceMap.resources ?? [];
  for (const resourceId of PLUGIN_RESOURCES) {
    const resource = resources.find((candidate) => candidate.resource_id === resourceId);
    if (!resource) {
      failures.push(`${resourceId}: missing .appsdk resource-map entry`);
      continue;
    }
    if (resource.status !== 'contract_bound') {
      failures.push(`${resourceId}: status must stay contract_bound before the plugin runtime node exists (got ${resource.status})`);
    }
    if (!String(resource.owner ?? '').startsWith('contract:')) {
      failures.push(`${resourceId}: owner must be a contract-bound owner`);
    }
  }

  return failures;
}

function runSelfTest() {
  const contracts = {
    'v4-node-plugin': readJson('contracts/node-plugin.contract.json'),
    'v4-node-container': readJson('contracts/node-container.contract.json'),
    'v4-plugin-catalog': readJson('contracts/plugin-catalog.contract.json'),
  };
  const moduleRegistry = readJson('.appsdk/maps/module-registry.json');
  const verificationMap = readJson('.appsdk/maps/verification-map.json');
  const functionMap = readJson('.appsdk/maps/function-map.json');
  const resourceMap = readJson('.appsdk/maps/resource-map.json');

  const cases = [
    ['contract status downgraded', (state) => {
      state.contracts['v4-node-plugin'].status = 'design';
    }],
    ['ordering tie rule removed', (state) => {
      state.contracts['v4-node-container'].ordering_rule = 'order only';
    }],
    ['selection rule removed', (state) => {
      delete state.contracts['v4-node-plugin'].selection_group_rule;
    }],
    ['catalog snapshot rule removed', (state) => {
      delete state.contracts['v4-plugin-catalog'].snapshot_rule;
    }],
    ['module registry entry missing', (state) => {
      state.moduleRegistry.modules = state.moduleRegistry.modules.filter(
        (module) => module.module_id !== 'routecodex-v4-plugin-plan',
      );
    }],
    ['module owned_path missing', (state) => {
      const module = state.moduleRegistry.modules.find(
        (candidate) => candidate.module_id === 'routecodex-v4-plugin-contract',
      );
      module.owned_paths = [];
    }],
    ['verification gate unregistered', (state) => {
      state.verificationMap.gates = state.verificationMap.gates.filter(
        (gate) => gate.gate_id !== 'v4_parity_gate_plugin_plan',
      );
    }],
    ['function-map entry missing', (state) => {
      state.functionMap.functions = state.functionMap.functions.filter(
        (entry) => entry.function_id !== 'v4.plugin.plan',
      );
    }],
    ['function-map symbol missing', (state) => {
      const entry = state.functionMap.functions.find(
        (candidate) => candidate.function_id === 'v4.plugin.contract',
      );
      entry.entry_symbols = ['GhostSymbol'];
    }],
    ['plugin resource drifted to active', (state) => {
      const resource = state.resourceMap.resources.find(
        (candidate) => candidate.resource_id === 'v4.plugin.node_plugin_plan',
      );
      resource.status = 'active';
      resource.owner = 'routecodex-v4-plugin-plan::compile_node_plan';
    }],
  ];

  let failed = 0;
  for (const [name, mutate] of cases) {
    const state = {
      contracts: clone(contracts),
      moduleRegistry: clone(moduleRegistry),
      verificationMap: clone(verificationMap),
      functionMap: clone(functionMap),
      resourceMap: clone(resourceMap),
    };
    mutate(state);
    const failures = validate(
      state.contracts,
      state.moduleRegistry,
      state.verificationMap,
      state.functionMap,
      state.resourceMap,
    );
    if (failures.length === 0) {
      console.error(`[v4_parity_gate_plugin_plan] red self-test ${name}: expected FAIL, got PASS`);
      failed += 1;
    } else {
      console.log(`[v4_parity_gate_plugin_plan] red self-test ${name}: FAIL as expected (${failures.length})`);
    }
  }
  if (failed > 0) {
    process.exit(1);
  }
  console.log('[v4_parity_gate_plugin_plan] OK red self-test 10/10');
}

const isRedSelfTest = process.argv.includes('--red-self-test');
if (isRedSelfTest) {
  runSelfTest();
} else {
  const failures = validate(
    {
      'v4-node-plugin': readJson('contracts/node-plugin.contract.json'),
      'v4-node-container': readJson('contracts/node-container.contract.json'),
      'v4-plugin-catalog': readJson('contracts/plugin-catalog.contract.json'),
    },
    readJson('.appsdk/maps/module-registry.json'),
    readJson('.appsdk/maps/verification-map.json'),
    readJson('.appsdk/maps/function-map.json'),
    readJson('.appsdk/maps/resource-map.json'),
  );
  if (failures.length > 0) {
    console.error('[v4_parity_gate_plugin_plan] FAIL');
    console.error(failures.join('\n'));
    process.exit(1);
  }
  console.log('[v4_parity_gate_plugin_plan] OK plugin contract/catalog/plan modules bound');
}
