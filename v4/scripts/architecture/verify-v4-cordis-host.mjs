#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(new URL('.', import.meta.url).pathname, '..', '..');
const sourcePath = path.join(root, 'cordis/routecodex-v4-cordis-host/src/index.mjs');
const bindingContractPath = path.join(root, 'contracts/node-container-host-binding.contract.json');
const functionMapPath = path.join(root, 'docs/architecture/maps/function-map.json');
const mainlinePath = path.join(root, 'docs/architecture/maps/mainline-call-map.json');
const resourceMapPath = path.join(root, 'docs/architecture/maps/resource-map.json');
const clone = (value) => JSON.parse(JSON.stringify(value));
const forbidden = [
  'metadata',
  'fallback',
  'next_node',
];

function validate(source, bindingContract, functionMap, mainline, resourceMap) {
  const failures = [];
  if (forbidden.some((token) => source.includes(token))) {
    failures.push('Cordis host contains forbidden synthetic/control pattern');
  }
  if (
    bindingContract.status !== 'active'
    || bindingContract.owner_feature_ids?.caller !== 'v4.cordis.host_binding'
    || bindingContract.owner_feature_ids?.callee !== 'v4.node_container.lifecycle_dispatch'
    || !bindingContract.failure_rule?.includes('v4.node_container.lifecycle_failure')
    || !bindingContract.execution_rule?.includes('execute_with_plan_hash')
    || !bindingContract.execution_failure_rule?.includes('v4.node_container.execution_failure')
    || !bindingContract.execution_failure_codes?.includes('resource_access_violation')
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

function runSelfTest() {
  const source = fs.readFileSync(sourcePath, 'utf8');
  const bindingContract = JSON.parse(fs.readFileSync(bindingContractPath, 'utf8'));
  const functionMap = JSON.parse(fs.readFileSync(functionMapPath, 'utf8'));
  const mainline = JSON.parse(fs.readFileSync(mainlinePath, 'utf8'));
  const resourceMap = JSON.parse(fs.readFileSync(resourceMapPath, 'utf8'));
  let missed = 0;
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
    source, bindingContract, functionMap,
    executionMaps.mainline, executionMaps.resourceMap,
  );
  if (executionResourceFailures.length === 0) {
    console.error('[v4 cordis host red] execution failure resource/edge removed: expected FAIL, got PASS');
    missed += 1;
  } else {
    console.log(`[v4 cordis host red] execution failure resource/edge removed: FAIL as expected (${executionResourceFailures.length})`);
  }
  if (missed > 0) process.exit(1);
  console.log('[v4 cordis host red] OK red self-test 1/1');
}

if (process.argv.includes('--red-self-test')) {
  runSelfTest();
  process.exit(0);
}

const failures = validate(
  fs.readFileSync(sourcePath, 'utf8'),
  JSON.parse(fs.readFileSync(bindingContractPath, 'utf8')),
  JSON.parse(fs.readFileSync(functionMapPath, 'utf8')),
  JSON.parse(fs.readFileSync(mainlinePath, 'utf8')),
  JSON.parse(fs.readFileSync(resourceMapPath, 'utf8')),
);
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('[v4 cordis host] OK typed execution protocol + binding contract/maps');
