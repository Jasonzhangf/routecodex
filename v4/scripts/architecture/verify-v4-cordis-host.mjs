#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(new URL('.', import.meta.url).pathname, '..', '..');
const sourcePath = path.join(root, 'cordis/routecodex-v4-cordis-host/src/index.mjs');
const testsPath = path.join(root, 'cordis/routecodex-v4-cordis-host/tests/host.test.mjs');
const bindingTestsPath = path.join(root, 'cordis/routecodex-v4-cordis-host/tests/host-binding.test.mjs');
const bindingContractPath = path.join(root, 'contracts/node-container-host-binding.contract.json');
const functionMapPath = path.join(root, '.appsdk/maps/function-map.json');
const mainlinePath = path.join(root, '.appsdk/maps/mainline-call-map.json');
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
  "await this.#port.request('drain')",
  "await this.#port.request('status')",
];
const forbidden = ['metadata', 'fallback', 'next_node', 'inFlight: 0', '#inFlight'];

function validate(source, tests, bindingTests, bindingContract, functionMap, mainline) {
  const failures = required.filter((token) => !source.includes(token));
  if (forbidden.some((token) => source.includes(token))) {
    failures.push('Cordis host contains forbidden synthetic/control pattern');
  }
  if (
    !tests.includes('Context.is(host.context)')
    || !tests.includes('reverse order')
    || !tests.includes('failing in-flight fiber is disposed before mount rejects')
  ) {
    failures.push('black-box lifecycle tests missing');
  }
  if (
    !bindingTests.includes('real Cordis host drives the Rust NodeContainer lifecycle')
    || !bindingTests.includes('Cordis graph/plan drift is rejected before Rust publish')
    || !bindingTests.includes('Cordis mount failure fails and disposes the Rust candidate')
    || !bindingTests.includes('accepting-state disposal rejects before either lifecycle owner is mutated')
    || !bindingTests.includes('Rust binding spawn failure rejects pending lifecycle requests')
    || !bindingTests.includes("error.code === 'in_flight'")
  ) {
    failures.push('joint Cordis/Rust lifecycle tests missing');
  }
  if (
    bindingContract.status !== 'active'
    || bindingContract.owner_feature_ids?.caller !== 'v4.cordis.host_binding'
    || bindingContract.owner_feature_ids?.callee !== 'v4.node_container.lifecycle_dispatch'
    || !bindingContract.required_tests?.includes('in-flight execution rejects drain and leaves state accepting')
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
    || !edge.callee_symbols?.includes('HostBindingRuntime::handle')
  ) {
    failures.push('Cordis host -> NodeContainer mainline edge is not active');
  }
  const caller = functionMap.functions.find((entry) => entry.function_id === 'v4.cordis.host_binding');
  const callee = functionMap.functions.find((entry) => entry.function_id === 'v4.node_container.lifecycle_dispatch');
  if (
    caller?.owner !== 'routecodex-v4-cordis-host'
    || caller.entry_paths?.length !== 1
    || caller.entry_paths[0] !== 'cordis/routecodex-v4-cordis-host/src/index.mjs'
    || callee?.owner !== 'routecodex-v4-node-container'
    || callee.entry_paths?.length !== 1
    || callee.entry_paths[0] !== 'crates/routecodex-v4-node-container/src/bin/host_binding.rs'
  ) {
    failures.push('host binding caller/callee feature ownership is not split at the module edge');
  }
  return failures;
}

function runSelfTest() {
  const source = fs.readFileSync(sourcePath, 'utf8');
  const tests = fs.readFileSync(testsPath, 'utf8');
  const bindingTests = fs.readFileSync(bindingTestsPath, 'utf8');
  const bindingContract = JSON.parse(fs.readFileSync(bindingContractPath, 'utf8'));
  const functionMap = JSON.parse(fs.readFileSync(functionMapPath, 'utf8'));
  const mainline = JSON.parse(fs.readFileSync(mainlinePath, 'utf8'));
  const cases = [
    ['real Cordis import removed', (candidate) => candidate.replace("from 'cordis'", "from 'fake-cordis'")],
    ['real Context removed', (candidate) => candidate.replace('new Context()', 'new FakeContext()')],
    ['failed Fiber tracking moved after await', (candidate) => candidate.replace(
      'mounted.push({ id: plugin.id, fiber });\n        await fiber.await();',
      'await fiber.await();\n        mounted.push({ id: plugin.id, fiber });',
    )],
  ];
  let missed = 0;
  for (const [name, mutate] of cases) {
    const failures = validate(mutate(source), tests, bindingTests, bindingContract, functionMap, mainline);
    if (failures.length === 0) {
      console.error(`[v4 cordis host red] ${name}: expected FAIL, got PASS`);
      missed += 1;
    } else {
      console.log(`[v4 cordis host red] ${name}: FAIL as expected (${failures.length})`);
    }
  }
  if (missed > 0) process.exit(1);
  const bindingCases = [
    ['fabricated drain projection', source.replace("return { nodeId: this.nodeId, state: status.state, inFlight: status.in_flight };", "return { nodeId: this.nodeId, state: status.state, inFlight: 0 };")],
    ['second in-flight truth added', source.replace('#mounted = false;', '#inFlight = 0;\n  #mounted = false;')],
  ];
  for (const [name, candidate] of bindingCases) {
    const failures = validate(candidate, tests, bindingTests, bindingContract, functionMap, mainline);
    if (failures.length === 0) {
      console.error(`[v4 cordis host red] ${name}: expected FAIL, got PASS`);
      missed += 1;
    } else {
      console.log(`[v4 cordis host red] ${name}: FAIL as expected (${failures.length})`);
    }
  }
  if (missed > 0) process.exit(1);
  console.log('[v4 cordis host red] OK red self-test 5/5');
}

if (process.argv.includes('--red-self-test')) {
  runSelfTest();
  process.exit(0);
}

const failures = validate(
  fs.readFileSync(sourcePath, 'utf8'),
  fs.readFileSync(testsPath, 'utf8'),
  fs.readFileSync(bindingTestsPath, 'utf8'),
  JSON.parse(fs.readFileSync(bindingContractPath, 'utf8')),
  JSON.parse(fs.readFileSync(functionMapPath, 'utf8')),
  JSON.parse(fs.readFileSync(mainlinePath, 'utf8')),
);
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('[v4 cordis host] OK real Context/Fiber/Effect + Rust lifecycle binding');
