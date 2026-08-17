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
  'pub fn execute_with_plan_hash',
  'expected_plan_hash != self.plan.hash',
  'PlanHashMismatch',
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
    || !binding.includes('#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]')
    || !binding.includes('serde_ignored::deserialize')
    || !binding.includes("use serde_json::value::RawValue;")
    || !binding.includes('pub struct LifecycleFailureFact')
    || !binding.includes('resource_id: "v4.node_container.lifecycle_failure"')
    || !binding.includes('ExecuteNode {')
    || !binding.includes('pub struct ExecutionFailureFact')
    || !binding.includes('resource_id: "v4.node_container.execution_failure"')
    || !binding.includes('execute_with_plan_hash(')
    || !binding.includes('EnterExecution')
    || !binding.includes('NodeContainer::declare')
    || !binding.includes('NodeContainerError::InFlightExecutions')
  ) {
    failures.push('typed host lifecycle binding missing');
  }
  if (
    !tests.includes('positive_in_flight_guard_tracks_and_releases_execution')
    || !tests.includes('negative_drain_rejects_measured_in_flight_execution')
    || !tests.includes('positive_execute_is_bound_to_active_plan_hash')
    || !tests.includes('negative_execute_rejects_plan_hash_drift')
  ) {
    failures.push('in-flight/plan-hash positive/negative lifecycle tests missing');
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
    ['plan-hash execution binding removed', (source) => source.replace('expected_plan_hash != self.plan.hash', 'false')],
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
  const permissiveBinding = binding.replace(', deny_unknown_fields)]', ')]');
  const protocolFailures = validate(baseline, permissiveBinding, tests);
  if (protocolFailures.length === 0) {
    console.error('[v4 node container red] permissive lifecycle decoder: expected FAIL, got PASS');
    missed += 1;
  } else {
    console.log(`[v4 node container red] permissive lifecycle decoder: FAIL as expected (${protocolFailures.length})`);
  }
  const nestedPermissiveBinding = binding.replace('serde_ignored::deserialize', 'serde_json::from_str');
  const nestedProtocolFailures = validate(baseline, nestedPermissiveBinding, tests);
  if (nestedProtocolFailures.length === 0) {
    console.error('[v4 node container red] nested unknown-field detector removed: expected FAIL, got PASS');
    missed += 1;
  } else {
    console.log(`[v4 node container red] nested unknown-field detector removed: FAIL as expected (${nestedProtocolFailures.length})`);
  }
  const untypedFailureBinding = binding.replace(
    'pub struct LifecycleFailureFact',
    'struct StringFailureProjection',
  );
  const failureFactFailures = validate(baseline, untypedFailureBinding, tests);
  if (failureFactFailures.length === 0) {
    console.error('[v4 node container red] typed lifecycle failure removed: expected FAIL, got PASS');
    missed += 1;
  } else {
    console.log(`[v4 node container red] typed lifecycle failure removed: FAIL as expected (${failureFactFailures.length})`);
  }
  const untypedExecutionFailureBinding = binding.replace(
    'pub struct ExecutionFailureFact',
    'struct StringExecutionFailureProjection',
  );
  const executionFailureFailures = validate(baseline, untypedExecutionFailureBinding, tests);
  if (executionFailureFailures.length === 0) {
    console.error('[v4 node container red] typed execution failure removed: expected FAIL, got PASS');
    missed += 1;
  } else {
    console.log(`[v4 node container red] typed execution failure removed: FAIL as expected (${executionFailureFailures.length})`);
  }
  const executionOpRemovedBinding = binding.replaceAll('ExecuteNode {', 'Status {');
  const executionOpFailures = validate(baseline, executionOpRemovedBinding, tests);
  if (executionOpFailures.length === 0) {
    console.error('[v4 node container red] execute_node operation removed: expected FAIL, got PASS');
    missed += 1;
  } else {
    console.log(`[v4 node container red] execute_node operation removed: FAIL as expected (${executionOpFailures.length})`);
  }
  if (missed > 0) process.exit(1);
  console.log('[v4 node container red] OK red self-test 10/10');
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
