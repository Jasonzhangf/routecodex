#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(new URL('.', import.meta.url).pathname, '..', '..');
const sourcePath = path.join(root, 'crates/routecodex-v4-node-container/src/lib.rs');
const bindingPath = path.join(root, 'crates/routecodex-v4-node-container/src/bin/host_binding.rs');
const testsPath = path.join(root, 'crates/routecodex-v4-node-container/tests/l2_node_container.rs');
const required = [
  'pub struct NodeContainer',
  'pub fn fail',
  'PlanBindings',
  'execute_plan',
  'NodeContainerState',
  'loaded_plan_hash != plan.hash',
  'pub fn enter_execution',
  'pub fn in_flight',
  'NodeExecutionGuard',
  'InFlightExecutions',
];
const forbidden = ['struct Context', 'struct Fiber', 'struct Effect', 'serde_json::Value'];

function validate(source, binding, tests) {
  const failures = required.filter((token) => !source.includes(token));
  if (forbidden.some((token) => source.includes(token))) {
    failures.push('Rust node-container contains a Cordis-like runtime or generic payload');
  }
  if (
    !binding.includes('enum HostRequest')
    || !binding.includes('EnterExecution')
    || !binding.includes('NodeContainer::declare')
    || !binding.includes('NodeContainerError::InFlightExecutions')
  ) {
    failures.push('typed host lifecycle binding missing');
  }
  if (
    !tests.includes('positive_in_flight_guard_tracks_and_releases_execution')
    || !tests.includes('negative_drain_rejects_measured_in_flight_execution')
  ) {
    failures.push('in-flight positive/negative lifecycle tests missing');
  }
  return failures;
}

function runSelfTest() {
  const baseline = fs.readFileSync(sourcePath, 'utf8');
  const binding = fs.readFileSync(bindingPath, 'utf8');
  const tests = fs.readFileSync(testsPath, 'utf8');
  const cases = [
    ['synthetic Cordis runtime', (source) => `${source}\nstruct Context;`],
    ['plan binding guard removed', (source) => source.replace('loaded_plan_hash != plan.hash', 'false')],
    ['failed-state transition removed', (source) => source.replace('pub fn fail', 'fn fail')],
  ];
  let missed = 0;
  for (const [name, mutate] of cases) {
    const failures = validate(mutate(baseline), binding, tests);
    if (failures.length === 0) {
      console.error(`[v4 node container red] ${name}: expected FAIL, got PASS`);
      missed += 1;
    } else {
      console.log(`[v4 node container red] ${name}: FAIL as expected (${failures.length})`);
    }
  }
  if (missed > 0) process.exit(1);
  const inFlightCandidate = baseline.replace('pub fn enter_execution', 'fn enter_execution');
  const inFlightFailures = validate(inFlightCandidate, binding, tests);
  if (inFlightFailures.length === 0) {
    console.error('[v4 node container red] in-flight owner removed: expected FAIL, got PASS');
    missed += 1;
  } else {
    console.log(`[v4 node container red] in-flight owner removed: FAIL as expected (${inFlightFailures.length})`);
  }
  if (missed > 0) process.exit(1);
  console.log('[v4 node container red] OK red self-test 4/4');
}

if (process.argv.includes('--red-self-test')) {
  runSelfTest();
  process.exit(0);
}

const failures = validate(
  fs.readFileSync(sourcePath, 'utf8'),
  fs.readFileSync(bindingPath, 'utf8'),
  fs.readFileSync(testsPath, 'utf8'),
);
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('[v4 node container] OK typed lifecycle, in-flight truth and host binding');
