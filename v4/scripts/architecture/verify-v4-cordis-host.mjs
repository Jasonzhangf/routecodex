#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(new URL('.', import.meta.url).pathname, '..', '..');
const sourcePath = path.join(root, 'cordis/routecodex-v4-cordis-host/src/index.mjs');
const testsPath = path.join(root, 'cordis/routecodex-v4-cordis-host/tests/host.test.mjs');
const bindingTestsPath = path.join(root, 'cordis/routecodex-v4-cordis-host/tests/host-binding.test.mjs');
const bindingContractPath = path.join(root, 'contracts/node-container-host-binding.contract.json');
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
  'this.#inFlight += 1',
];
const forbidden = ['metadata', 'fallback', 'next_node', 'inFlight: 0'];

function validate(source, tests, bindingTests, bindingContract, mainline) {
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
    || !bindingTests.includes('Rust binding spawn failure rejects pending lifecycle requests')
    || !bindingTests.includes("error.code === 'in_flight'")
  ) {
    failures.push('joint Cordis/Rust lifecycle tests missing');
  }
  if (
    bindingContract.status !== 'active'
    || bindingContract.owner_feature_id !== 'v4.node_container.host_binding'
    || !bindingContract.required_tests?.includes('in-flight execution rejects drain and leaves state accepting')
  ) {
    failures.push('host binding contract is missing or drifted');
  }
  const edge = mainline.edges.find((entry) => (
    entry.from === 'routecodex-v4-cordis-host'
    && entry.to === 'routecodex-v4-node-container'
  ));
  if (!edge || edge.status !== 'active' || !edge.symbols?.includes('CordisBoundNodeHost')) {
    failures.push('Cordis host -> NodeContainer mainline edge is not active');
  }
  return failures;
}

function runSelfTest() {
  const source = fs.readFileSync(sourcePath, 'utf8');
  const tests = fs.readFileSync(testsPath, 'utf8');
  const bindingTests = fs.readFileSync(bindingTestsPath, 'utf8');
  const bindingContract = JSON.parse(fs.readFileSync(bindingContractPath, 'utf8'));
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
    const failures = validate(mutate(source), tests, bindingTests, bindingContract, mainline);
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
    ['in-flight binding removed', source.replace('this.#inFlight += 1', 'this.#inFlight += 0')],
  ];
  for (const [name, candidate] of bindingCases) {
    const failures = validate(candidate, tests, bindingTests, bindingContract, mainline);
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
  JSON.parse(fs.readFileSync(mainlinePath, 'utf8')),
);
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('[v4 cordis host] OK real Context/Fiber/Effect + Rust lifecycle binding');
