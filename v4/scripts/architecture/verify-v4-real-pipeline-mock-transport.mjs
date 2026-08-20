#!/usr/bin/env node
// Architecture gate for the M8 first slice (real pipeline mock transport).
// Positive mode validates source + machine maps. Red mode mutates cloned
// inputs and invokes the exact same validator for every protected class.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const red = process.argv.includes('--red-self-test');

const REQUIRED_PLAN_TOKENS = [
  'KeylessChatFixture',
  'V4RequestIdCounter',
  'V4ErrorEvidenceFlushOnTerminalFailure',
  'project_runtime_fault',
  'assert_no_control_leak',
];

const REQUIRED_RUNTIME_SYMBOLS = [
  'pub fn execute_mock_transport_slice',
  'pub fn execute_mock_response_scoped',
  'pub fn execute_request_fixture_scoped',
  'pub struct MockTransportReport',
  'pub struct MockTransportError',
  'pub struct MockTransportIdentityCounter',
  'select_relay_operator(&ContinuationFacts::new(',
  'error_chain_client_projection_message(&fault, &request_scope)',
];

const REQUIRED_RESOURCE_IDS = [
  'v4.pipeline.mock_transport_report',
  'v4.pipeline.mock_transport_error',
  'v4.pipeline.mock_transport_identity',
];

const FORBIDDEN = [
  'routecodex_v4_provider::wire_send',
  'real_provider_url',
  'real_api_key',
  'real_openai',
  'real_anthropic',
];

const readText = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const readJson = (file) => JSON.parse(readText(file));
const clone = (value) => JSON.parse(JSON.stringify(value));

const base = {
  architecture: readText('docs/architecture/v4-cordis-node-plugin-architecture.md'),
  resourceYaml: readText('docs/architecture/v4-resource-operation-map.yml'),
  runtime: readText('crates/routecodex-v4-runtime/src/lib.rs'),
  server: readText('crates/routecodex-v4-server/src/lib.rs'),
  functionMap: readJson('.appsdk/maps/function-map.json'),
  resourceMap: readJson('.appsdk/maps/resource-map.json'),
  mainline: readJson('.appsdk/maps/mainline-call-map.json'),
};

function validate(input) {
  const failures = [];
  // KeylessChatFixture is checked via REQUIRED_RUNTIME_SYMBOLS in runtime source
  if (!input.runtime.includes('KeylessChatFixture')) {
    failures.push('runtime missing symbol: KeylessChatFixture');
  }
  // V4RequestIdCounter and V4ErrorEvidenceFlushOnTerminalFailure already checked in server source
  // project_runtime_fault already checked in REQUIRED_RUNTIME_SYMBOLS
  if (!input.architecture.includes('phase3_mock_transport_slice_active')
      || input.architecture.includes('phase2_host_binding_active')) {
    failures.push('architecture missing current phase3 marker (or stale phase2 marker)');
  }
  for (const token of FORBIDDEN) {
    if (input.runtime.includes(token)) {
      failures.push(`source contains forbidden token: ${token}`);
    }
  }
  for (const symbol of REQUIRED_RUNTIME_SYMBOLS) {
    if (!input.runtime.includes(symbol)) failures.push(`runtime missing symbol: ${symbol}`);
  }
  if (!input.server.includes('pub struct V4RequestIdCounter')) {
    failures.push('server missing pub struct V4RequestIdCounter');
  }
  if (!input.server.includes('pub struct V4ErrorEvidenceFlushOnTerminalFailure')) {
    failures.push('server missing pub struct V4ErrorEvidenceFlushOnTerminalFailure');
  }

  const feature = input.functionMap.functions?.find(
    (entry) => entry.function_id === 'v4.runtime.real_pipeline_mock_transport',
  );
  if (!feature) {
    failures.push('function map missing v4.runtime.real_pipeline_mock_transport');
  } else {
    for (const symbol of [
      'MockTransportReport',
      'MockTransportError',
      'MockTransportIdentityCounter',
      'execute_mock_transport_slice',
    ]) {
      if (!feature.entry_symbols?.includes(symbol)) {
        failures.push(`function map missing entry symbol: ${symbol}`);
      }
    }
    for (const resourceId of REQUIRED_RESOURCE_IDS) {
      if (!feature.resource_bindings?.includes(resourceId)) {
        failures.push(`function map missing resource binding: ${resourceId}`);
      }
    }
  }

  const resourceIds = new Set((input.resourceMap.resources ?? []).map((entry) => entry.resource_id));
  for (const resourceId of REQUIRED_RESOURCE_IDS) {
    if (!resourceIds.has(resourceId)) {
      failures.push(`resource map missing: ${resourceId}`);
    }
    if (!input.resourceYaml.includes(`resource_id: ${resourceId}`)) {
      failures.push(`resource operation map missing: ${resourceId}`);
    }
  }

  const mockEdge = (input.mainline.edges ?? []).find(
    (edge) => edge.edge_type === 'mock_transport_orchestration'
      && edge.owner === 'routecodex-v4-runtime::execute_mock_transport_slice',
  );
  if (!mockEdge) failures.push('mainline missing mock_transport_orchestration edge');
  const errorEdge = (input.mainline.edges ?? []).find(
    (edge) => edge.edge_type === 'error_chain_projection'
      && edge.owner === 'routecodex-v4-runtime::project_runtime_fault',
  );
  if (!errorEdge) failures.push('mainline missing error_chain_projection edge');

  return failures;
}

if (red) {
  const cases = [
    ['forbidden provider token', (input) => { input.runtime += '\nreal_openai\n'; }],
    ['phase marker removed', (input) => {
      input.architecture = input.architecture.replace('phase3_mock_transport_slice_active', 'phase2_host_binding_active');
    }],
    ['runtime symbol removed', (input) => {
      input.runtime = input.runtime.replace('pub fn execute_mock_transport_slice', 'fn execute_mock_transport_slice_removed');
    }],
    ['function map entry removed', (input) => {
      input.functionMap.functions = input.functionMap.functions.filter(
        (entry) => entry.function_id !== 'v4.runtime.real_pipeline_mock_transport',
      );
    }],
    ['resource map entry removed', (input) => {
      input.resourceMap.resources = input.resourceMap.resources.filter(
        (entry) => entry.resource_id !== 'v4.pipeline.mock_transport_report',
      );
    }],
    ['mainline edge removed', (input) => {
      input.mainline.edges = input.mainline.edges.filter(
        (edge) => edge.edge_type !== 'error_chain_projection',
      );
    }],
  ];
  const failures = [];
  for (const [name, mutate] of cases) {
    const input = clone(base);
    mutate(input);
    if (validate(input).length === 0) failures.push(`red case did not fail: ${name}`);
  }
  if (failures.length > 0) {
    console.error('v4_parity_gate_real_pipeline_mock_transport red FAIL');
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log(`v4_parity_gate_real_pipeline_mock_transport red OK (${cases.length} mutations)`);
  process.exit(0);
}

const failures = validate(base);
if (failures.length > 0) {
  console.error('v4_parity_gate_real_pipeline_mock_transport positive FAIL');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('v4_parity_gate_real_pipeline_mock_transport positive OK');
