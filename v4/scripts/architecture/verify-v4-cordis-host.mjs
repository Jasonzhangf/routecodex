#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(new URL('.', import.meta.url).pathname, '..', '..');
const sourcePath = path.join(root, 'cordis/routecodex-v4-cordis-host/src/index.mjs');
const daemonSourcePath = path.join(root, 'cordis/routecodex-v4-cordis-host/src/daemon.mjs');
const testsPath = path.join(root, 'cordis/routecodex-v4-cordis-host/tests/host.test.mjs');
const bindingTestsPath = path.join(root, 'cordis/routecodex-v4-cordis-host/tests/host-binding.test.mjs');
const daemonTestsPath = path.join(root, 'cordis/routecodex-v4-cordis-host/tests/daemon.test.mjs');
const bindingContractPath = path.join(root, 'contracts/node-container-host-binding.contract.json');
const ratchetPath = path.join(root, 'contracts/cordis-mainline-ratchet.json');
const ratchetBaselineIds = [
  'internal_rust_node_container',
  'static_plugin_registry',
  'runtime_bin_direct_business_calls',
  'discarded_node_output',
  'test_only_cordis_binding_in_production_shape',
];
const ratchetCurrentExceptionIds = ['runtime_bin_direct_business_calls'];
const ratchetCanonicalDocs = [
  'docs/architecture/v4-cordis-mainline-adr.md',
  'docs/goals/v4-cordis-mainline-migration-plan.md',
];
const ratchetForbiddenPlanPattern = /v4\.test\.[A-Za-z0-9_-]+/;
const functionMapPath = path.join(root, 'docs/architecture/maps/function-map.json');
const mainlinePath = path.join(root, 'docs/architecture/maps/mainline-call-map.json');
const resourceMapPath = path.join(root, 'docs/architecture/maps/resource-map.json');
const clone = (value) => JSON.parse(JSON.stringify(value));
const required = [
  'from \'cordis\'',
  'new Context()',
  'FiberState.ACTIVE',
  '.isolate(',
  'fiber.dispose()',
  'plugin_not_active',
  'mounted.push({ id: plugin.id, fiber });\n        await fiber.await();',
  'export class CordisBoundNodeHost',
  'export class RustNodeContainerPort',
  'computeNodePluginPlanHash',
  'declare(nodeId, plan, bindings, ...extra)',
  'status(...fields)',
  'executeNode(planHash, input, ...extra)',
  'async executeNode(planHash, input)',
  'EXECUTION_FAILURE_CODES',
  "'resource_access_violation'",
  'decodeExecutionOutput',
  'validateExecutionInput',
  "const allowedKeys = new Set(['data', 'control', 'information', 'diagnostics']);",
  "const allowedKeys = new Set(['data', 'control', 'information']);",
  "failure.resource_id === 'v4.node_container.execution_failure'",
  'await this.#port.drain()',
  'await this.#port.status()',
  'export function cordisCatalogIdentityKey',
  'export function createCordisPluginFactory',
  'canonical catalog entries are required',
  'catalog_implementation_mismatch',
  'catalog_implementation_missing',
  'createPlugins(pluginEntries, configs = new Map())',
];
const forbidden = [
  'metadata',
  'fallback',
  'next_node',
  'inFlight: 0',
  '#inFlight',
  'async request(op, fields = {})',
];

function validate(source, daemonSource, tests, bindingTests, daemonTests, bindingContract, functionMap, mainline, resourceMap) {
  const failures = required.filter((token) => !source.includes(token));
  failures.push(...[
    'startCordisHostDaemon',
    'CordisHostDaemonClient',
    'CORDIS_HOST_PROTOCOL_VERSION',
    'generation',
    'graphHash',
    'lastHeartbeatAt',
    'reconcile',
  ].filter((token) => !daemonSource.includes(token)).map((token) => `daemon missing ${token}`));
  if (forbidden.some((token) => source.includes(token))) {
    failures.push('Cordis host contains forbidden synthetic/control pattern');
  }
  if (
    !tests.includes('Context.is(host.context)')
    || !tests.includes('reverse order')
    || !tests.includes('failing in-flight fiber is disposed before mount rejects')
    || !tests.includes('canonical catalog factory mounts generic Cordis fibers and disposes them in reverse order')
    || !tests.includes('canonical catalog factory rejects an implementation missing from the catalog')
  ) {
    failures.push('black-box lifecycle tests missing');
  }
  if (
    !bindingTests.includes('real Cordis host drives the Rust NodeContainer lifecycle')
    || !bindingTests.includes('Cordis graph/plan drift is rejected before Rust publish')
    || !bindingTests.includes('Cordis mount failure fails and disposes the Rust candidate')
    || !bindingTests.includes('accepting-state disposal rejects before either lifecycle owner is mutated')
    || !bindingTests.includes('Rust binding spawn failure rejects pending lifecycle requests')
    || !bindingTests.includes('unsolicited lifecycle response rejects pending requests and closes the port')
    || !bindingTests.includes('Rust lifecycle decoder rejects undeclared metadata and business fields')
    || !bindingTests.includes('JS lifecycle encoder rejects fields not declared by the operation')
    || !bindingTests.includes("error.failure?.resource_id === 'v4.node_container.lifecycle_failure'")
    || !bindingTests.includes("error.failure?.resource_id === 'v4.node_container.execution_failure'")
    || !bindingTests.includes("error.code === 'in_flight'")
    || !bindingTests.includes('real Cordis fibers drive ordered Rust NodePluginPlan execution')
    || !bindingTests.includes('execution plan hash mismatch fails before Rust handles run')
    || !bindingTests.includes('unregistered plugin handle fails fast with typed execution failure')
    || !bindingTests.includes('resource access violation retains its typed execution failure code')
    || !bindingTests.includes("error.code === 'resource_access_violation'")
    || !bindingTests.includes('JS and Rust reject undeclared execution fields')
    || !bindingTests.includes('execute after drain rejects invalid_state')
    || !bindingTests.includes('JS execution response decoder rejects malformed output')
    || !bindingTests.includes('JS execution response decoder rejects missing output')
  ) {
    failures.push('joint Cordis/Rust lifecycle/execution tests missing');
  }
  if (
    !daemonTests.includes('daemon startup performs version/capability handshake')
    || !daemonTests.includes('heartbeat, reconnect, generation and graph reconciliation fail closed')
    || !daemonTests.includes('daemon refuses a second owner')
  ) {
    failures.push('Cordis host daemon tests missing');
  }
  if (
    bindingContract.status !== 'active'
    || bindingContract.owner_feature_ids?.caller !== 'v4.cordis.host_binding'
    || bindingContract.owner_feature_ids?.callee !== 'v4.node_container.lifecycle_dispatch'
    || !bindingContract.required_tests?.includes('in-flight execution rejects drain and leaves state accepting')
    || !bindingContract.failure_rule?.includes('v4.node_container.lifecycle_failure')
    || !bindingContract.execution_rule?.includes('execute_with_plan_hash')
    || !bindingContract.execution_failure_rule?.includes('v4.node_container.execution_failure')
    || !bindingContract.execution_failure_codes?.includes('resource_access_violation')
    || !bindingContract.required_tests?.includes('resource access violation retains its typed execution failure code')
    || !bindingContract.required_tests?.includes('real Cordis fibers drive ordered Rust NodePluginPlan execution')
  ) {
    failures.push('host binding contract is missing or drifted');
  }
  const edge = mainline.edges.find((entry) => (
    entry.from === 'routecodex-v4-cordis-host'
    && entry.to === 'routecodex-v4-node-container'
  ));
  if (
    !edge
    || edge.status !== 'active'
    || edge.caller_feature_id !== 'v4.cordis.host_binding'
    || edge.callee_feature_id !== 'v4.node_container.lifecycle_dispatch'
    || edge.caller_path !== 'cordis/routecodex-v4-cordis-host/src/index.mjs'
    || edge.callee_path !== 'crates/routecodex-v4-node-container/src/bin/host_binding.rs'
    || !edge.caller_symbols?.includes('CordisBoundNodeHost')
    || !edge.caller_symbols?.includes('RustNodeContainerPort::executeNode')
    || !edge.callee_symbols?.includes('HostRequest')
    || !edge.callee_symbols?.includes('HostBindingRuntime::handle')
    || !edge.symbols?.includes('NodeContainer::execute_with_plan_hash')
  ) {
    failures.push('Cordis host -> NodeContainer mainline edge is not active');
  }
  const caller = functionMap.functions.find((entry) => entry.function_id === 'v4.cordis.host_binding');
  const factory = functionMap.functions.find((entry) => entry.function_id === 'v4.cordis.generic_factory');
  const callee = functionMap.functions.find((entry) => entry.function_id === 'v4.node_container.lifecycle_dispatch');
  if (
    caller?.owner !== 'routecodex-v4-cordis-host'
    || caller.entry_paths?.length !== 1
    || caller.entry_paths[0] !== 'cordis/routecodex-v4-cordis-host/src/index.mjs'
    || callee?.owner !== 'routecodex-v4-node-container'
    || callee.entry_paths?.length !== 1
    || callee.entry_paths[0] !== 'crates/routecodex-v4-node-container/src/bin/host_binding.rs'
    || !callee.required_gates?.includes('v4_cordis_host_l3_regression')
  ) {
    failures.push('host binding caller/callee feature ownership is not split at the module edge');
  }
  if (
    factory?.owner !== 'routecodex-v4-cordis-host'
    || factory.feature_id !== 'v4.cordis_generic_factory'
    || !factory.entry_symbols?.includes('createCordisPluginFactory')
    || !factory.required_gates?.includes('v4_parity_gate_cordis_host')
  ) {
    failures.push('generic Cordis factory owner or gate binding is missing');
  }
  const factoryEdge = mainline.edges.find((entry) => entry.edge_type === 'catalog_factory_mount');
  if (
    factoryEdge?.from !== 'routecodex-v4-plugin-catalog'
    || factoryEdge?.to !== 'routecodex-v4-cordis-host'
    || factoryEdge.owner !== 'routecodex-v4-cordis-host::createCordisPluginFactory'
    || factoryEdge.callee_feature_id !== 'v4.cordis_generic_factory'
    || factoryEdge.resource_id !== 'v4.cordis.plugin_fibers'
  ) {
    failures.push('canonical catalog -> generic factory -> Cordis fiber edge is not active');
  }
  const failureEdge = mainline.edges.find((entry) => (
    entry.edge_type === 'lifecycle_failure_projection'
    && entry.resource_id === 'v4.node_container.lifecycle_failure'
  ));
  const failureResource = resourceMap.resources.find(
    (entry) => entry.resource_id === 'v4.node_container.lifecycle_failure',
  );
  if (
    failureEdge?.from !== 'routecodex-v4-node-container'
    || failureEdge?.to !== 'routecodex-v4-cordis-host'
    || failureEdge?.owner !== 'routecodex-v4-node-container::HostBindingRuntime'
    || failureResource?.owner !== 'routecodex-v4-node-container::LifecycleFailureFact'
    || failureResource?.status !== 'active'
  ) {
    failures.push('typed lifecycle failure resource/edge is missing or owned outside NodeContainer');
  }
  const executionEdge = mainline.edges.find((entry) => (
    entry.edge_type === 'execution_failure_projection'
    && entry.resource_id === 'v4.node_container.execution_failure'
  ));
  const executionResource = resourceMap.resources.find(
    (entry) => entry.resource_id === 'v4.node_container.execution_failure',
  );
  if (
    executionEdge?.from !== 'routecodex-v4-node-container'
    || executionEdge?.to !== 'routecodex-v4-cordis-host'
    || executionEdge?.owner !== 'routecodex-v4-node-container::HostBindingRuntime'
    || executionResource?.owner !== 'routecodex-v4-node-container::ExecutionFailureFact'
    || executionResource?.status !== 'active'
  ) {
    failures.push('typed execution failure resource/edge is missing or owned outside NodeContainer');
  }
  return failures;
}

function validateRatchet(ratchet, canonicalDocs, migrationPlan) {
  const failures = [];
  if (!ratchet || ratchet.status !== 'active') failures.push('Cordis mainline ratchet must be active');
  if (ratchet?.owner_feature_id !== 'v4.cordis.mainline') failures.push('Cordis mainline ratchet owner drifted');
  if (!ratchet?.rule?.includes('count may only decrease') || !ratchet?.rule?.includes('new bypasses fail')) {
    failures.push('Cordis mainline ratchet must declare monotonic bypass reduction');
  }
  if (JSON.stringify(ratchet?.baseline_exception_ids ?? []) !== JSON.stringify(ratchetBaselineIds)) {
    failures.push('Cordis mainline ratchet baseline exception set drifted');
  }
  const exceptions = ratchet?.known_exceptions ?? [];
  const ids = exceptions.map((entry) => entry?.id);
  if (new Set(ids).size !== ids.length || ids.some((id) => !ratchetBaselineIds.includes(id))) {
    failures.push('Cordis mainline ratchet contains a new or duplicate bypass exception');
  }
  if (JSON.stringify(ids) !== JSON.stringify(ratchetCurrentExceptionIds)) {
    failures.push('Cordis mainline ratchet restored a retired exception or lost the current exception');
  }
  if (exceptions.length > ratchetBaselineIds.length) {
    failures.push('Cordis mainline ratchet bypass count increased');
  }
  for (const entry of exceptions) {
    const evidencePath = entry?.evidence?.path;
    const evidenceSymbols = entry?.evidence?.symbols;
    const absoluteEvidencePath = typeof evidencePath === 'string' ? path.join(root, evidencePath) : '';
    const evidenceSource = absoluteEvidencePath && fs.existsSync(absoluteEvidencePath)
      ? fs.readFileSync(absoluteEvidencePath, 'utf8')
      : '';
    if (!evidencePath || !evidenceSource
        || !Array.isArray(evidenceSymbols) || evidenceSymbols.length === 0
        || evidenceSymbols.some((symbol) => typeof symbol !== 'string' || !evidenceSource.includes(symbol))
        || !ratchetCanonicalDocs.every((doc) => canonicalDocs.includes(doc))) {
      failures.push(`Cordis mainline ratchet evidence/doc binding invalid for ${entry?.id ?? '(missing)'}`);
    }
  }
  if (typeof migrationPlan !== 'string' || ratchetForbiddenPlanPattern.test(migrationPlan)) {
    failures.push('active migration plan reintroduces v4.test.* production bypass');
  }
  return failures;
}

function runSelfTest() {
  const source = fs.readFileSync(sourcePath, 'utf8');
  const daemonSource = fs.readFileSync(daemonSourcePath, 'utf8');
  const tests = fs.readFileSync(testsPath, 'utf8');
  const bindingTests = fs.readFileSync(bindingTestsPath, 'utf8');
  const daemonTests = fs.readFileSync(daemonTestsPath, 'utf8');
  const bindingContract = JSON.parse(fs.readFileSync(bindingContractPath, 'utf8'));
  const functionMap = JSON.parse(fs.readFileSync(functionMapPath, 'utf8'));
  const mainline = JSON.parse(fs.readFileSync(mainlinePath, 'utf8'));
  const resourceMap = JSON.parse(fs.readFileSync(resourceMapPath, 'utf8'));
  const ratchet = JSON.parse(fs.readFileSync(ratchetPath, 'utf8'));
  const canonicalDocs = ratchetCanonicalDocs.filter((doc) => fs.existsSync(path.join(root, doc)));
  const migrationPlan = fs.readFileSync(path.join(root, 'docs/goals/v4-cordis-mainline-migration-plan.md'), 'utf8');
  const cases = [
    ['real Cordis import removed', (candidate) => candidate.replace("from 'cordis'", "from 'fake-cordis'")],
    ['real Context removed', (candidate) => candidate.replace('new Context()', 'new FakeContext()')],
    ['failed Fiber tracking moved after await', (candidate) => candidate.replace(
      'mounted.push({ id: plugin.id, fiber });\n        await fiber.await();',
      'await fiber.await();\n        mounted.push({ id: plugin.id, fiber });',
    )],
    ['generic execution payload surface restored', (candidate) => candidate.replace(
      "const allowedKeys = new Set(['data', 'control', 'information']);",
      "const allowedKeys = new Set(['payload']);",
    )],
    ['executeNode surface removed', (candidate) => candidate.replace(
      'executeNode(planHash, input, ...extra)',
      'executeGhost(planHash, input, ...extra)',
    )],
    ['execution failure decoder removed', (candidate) => candidate.replace(
      "failure.resource_id === 'v4.node_container.execution_failure'",
      'false',
    )],
    ['resource access execution code removed', (candidate) => candidate.replace(
      "  'resource_access_violation',\n",
      '',
    )],
  ];
  let missed = 0;
  for (const [name, mutate] of cases) {
    const failures = validate(
      mutate(source), daemonSource, tests, bindingTests, daemonTests, bindingContract,
      functionMap, mainline, resourceMap,
    );
    if (failures.length === 0) {
      console.error(`[v4 cordis host red] ${name}: expected FAIL, got PASS`);
      missed += 1;
    } else {
      console.log(`[v4 cordis host red] ${name}: FAIL as expected (${failures.length})`);
    }
  }
  if (missed > 0) process.exit(1);
  const ratchetCases = [
    ['new bypass exception', (candidate) => ({ ratchet: { ...candidate, known_exceptions: [...candidate.known_exceptions, { id: 'new_bypass', evidence: { path: 'new', symbols: ['new'] } }] } })],
    ['retired bypass restored', (candidate) => ({ ratchet: { ...candidate, known_exceptions: [...candidate.known_exceptions, { id: 'static_plugin_registry', evidence: candidate.known_exceptions[0].evidence }] } })],
    ['evidence symbol missing', (candidate) => ({ ratchet: { ...candidate, known_exceptions: candidate.known_exceptions.map((entry) => ({ ...entry, evidence: { ...entry.evidence, symbols: ['missing_symbol'] } })) } })],
    ['baseline drift', (candidate) => ({ ratchet: { ...candidate, baseline_exception_ids: ['new_bypass'] } })],
    ['plan reintroduces test bypass', (candidate) => ({ ratchet: candidate, migrationPlan: 'v4.test.fake production plan' })],
  ];
  for (const [name, mutate] of ratchetCases) {
    const mutated = mutate(ratchet);
    const ratchetFailures = validateRatchet(mutated.ratchet ?? ratchet, canonicalDocs, mutated.migrationPlan ?? migrationPlan);
    if (ratchetFailures.length === 0) {
      console.error(`[v4 cordis host red] ${name}: expected FAIL, got PASS`);
      missed += 1;
    } else {
      console.log(`[v4 cordis host red] ${name}: FAIL as expected (${ratchetFailures.length})`);
    }
  }
  if (missed > 0) process.exit(1);
  const bindingCases = [
    ['fabricated drain projection', source.replace("return { nodeId: this.nodeId, state: status.state, inFlight: status.in_flight };", "return { nodeId: this.nodeId, state: status.state, inFlight: 0 };")],
    ['second in-flight truth added', source.replace('#mounted = false;', '#inFlight = 0;\n  #mounted = false;')],
    ['generic lifecycle field surface restored', source.replace('async #request(message)', 'async request(op, fields = {})')],
  ];
  for (const [name, candidate] of bindingCases) {
    const failures = validate(
      candidate, daemonSource, tests, bindingTests, daemonTests, bindingContract,
      functionMap, mainline, resourceMap,
    );
    if (failures.length === 0) {
      console.error(`[v4 cordis host red] ${name}: expected FAIL, got PASS`);
      missed += 1;
    } else {
      console.log(`[v4 cordis host red] ${name}: FAIL as expected (${failures.length})`);
    }
  }
  if (missed > 0) process.exit(1);
  const executionMaps = {
    mainline: clone(mainline),
    resourceMap: clone(resourceMap),
  };
  executionMaps.mainline.edges = executionMaps.mainline.edges.filter(
    (entry) => !(
      entry.edge_type === 'execution_failure_projection'
      && entry.resource_id === 'v4.node_container.execution_failure'
    ),
  );
  executionMaps.resourceMap.resources = executionMaps.resourceMap.resources.filter(
    (entry) => entry.resource_id !== 'v4.node_container.execution_failure',
  );
  const executionResourceFailures = validate(
    source, daemonSource, tests, bindingTests, daemonTests, bindingContract, functionMap,
    executionMaps.mainline, executionMaps.resourceMap,
  );
  if (executionResourceFailures.length === 0) {
    console.error('[v4 cordis host red] execution failure resource/edge removed: expected FAIL, got PASS');
    missed += 1;
  } else {
    console.log(`[v4 cordis host red] execution failure resource/edge removed: FAIL as expected (${executionResourceFailures.length})`);
  }
  if (missed > 0) process.exit(1);
  console.log(`[v4 cordis host red] OK red self-test ${cases.length + ratchetCases.length + bindingCases.length + 1}/${cases.length + ratchetCases.length + bindingCases.length + 1}`);
}

if (process.argv.includes('--red-self-test')) {
  runSelfTest();
  process.exit(0);
}

const failures = validate(
  fs.readFileSync(sourcePath, 'utf8'),
  fs.readFileSync(daemonSourcePath, 'utf8'),
  fs.readFileSync(testsPath, 'utf8'),
  fs.readFileSync(bindingTestsPath, 'utf8'),
  fs.readFileSync(daemonTestsPath, 'utf8'),
  JSON.parse(fs.readFileSync(bindingContractPath, 'utf8')),
  JSON.parse(fs.readFileSync(functionMapPath, 'utf8')),
  JSON.parse(fs.readFileSync(mainlinePath, 'utf8')),
  JSON.parse(fs.readFileSync(resourceMapPath, 'utf8')),
);
const ratchet = JSON.parse(fs.readFileSync(ratchetPath, 'utf8'));
const canonicalDocs = ratchetCanonicalDocs.filter((doc) => fs.existsSync(path.join(root, doc)));
const migrationPlan = fs.readFileSync(path.join(root, 'docs/goals/v4-cordis-mainline-migration-plan.md'), 'utf8');
failures.push(...validateRatchet(ratchet, canonicalDocs, migrationPlan));
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('[v4 cordis host] OK real Context/Fiber/Effect + Rust lifecycle binding');
