#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const v3Root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sourceRoot = process.env.ROUTECODEX_V3_SOURCE_ROOT
  ? resolve(process.env.ROUTECODEX_V3_SOURCE_ROOT)
  : resolve(v3Root, '..');

function read(relativePath) {
  return readFileSync(resolve(sourceRoot, relativePath), 'utf8');
}

function readYaml(relativePath) {
  return YAML.parse(read(relativePath));
}

function symbolExists(text, symbol) {
  const [owner, method = null] = symbol.split('::');
  if (method) return text.includes(owner) && text.includes(method);
  return new RegExp(`\\b(?:fn|struct|enum|trait)\\s+${symbol}\\b`).test(text);
}

const failures = [];
const mainline = readYaml('docs/architecture/v3-mainline-call-map.yml');
const resources = readYaml('docs/architecture/v3-resource-operation-map.yml').resources ?? [];
const resourceById = new Map(resources.map((resource) => [resource.resource_id, resource]));
const chain = mainline.chains?.find(({ chain_id }) => chain_id === 'v3.provider_key_health_model_granularity');
const edges = Object.groupBy(chain?.edges ?? [], ({ step_id }) => step_id);

for (const stepId of [
  'v3-provider-key-health-model-01',
  'v3-provider-key-health-model-02',
  'v3-provider-key-health-model-03',
]) {
  if (edges[stepId]?.length !== 1) failures.push(`${stepId} must be declared exactly once`);
}

const expectedEdges = [
  {
    id: 'v3-provider-key-health-model-01',
    from: 'V3Error02Classified',
    to: 'V3ProviderFailureAction',
    callerFile: 'v3/crates/routecodex-v3-runtime/src/provider_failure_runtime_policy.rs',
    callerSymbol: 'V3ProviderFailureRuntimeHealth::record_provider_failure_record_from_source',
    calleeFile: 'v3/crates/routecodex-v3-error/src/subscription.rs',
    calleeSymbol: 'build_v3_provider_failure_action_from_v3_error_02',
    owner: 'v3.debug_error_foundation',
    consumes: ['v3.error.classified'],
    produces: ['v3.provider.failure_action'],
  },
  {
    id: 'v3-provider-key-health-model-02',
    from: 'V3ProviderFailureAction',
    to: 'V3ProviderKeyHealthStore',
    callerFile: 'v3/crates/routecodex-v3-runtime/src/provider_failure_runtime_policy.rs',
    callerSymbol: 'V3ProviderFailureRuntimeHealth::record_provider_key_failure_action',
    calleeFile: 'v3/crates/routecodex-v3-provider-responses/src/key_health.rs',
    calleeSymbol: 'V3ProviderKeyHealthStore::record_provider_failure_action',
    owner: 'v3.provider_key_health_model_granularity',
    consumes: ['v3.provider.failure_action'],
    produces: ['v3.provider.key_health_state'],
  },
  {
    id: 'v3-provider-key-health-model-03',
    from: 'V3Target09CandidateSetExpanded',
    to: 'V3Target10ConcreteProviderSelected',
    callerFile: 'v3/crates/routecodex-v3-target/src/lib.rs',
    callerSymbol: 'V3TargetInterpreter::select_available_with_health',
    calleeFile: 'v3/crates/routecodex-v3-provider-responses/src/key_health.rs',
    calleeSymbol: 'V3ProviderSchedulingReader::scheduling_projection',
    owner: 'v3.virtual_router_target_interpreter',
    consumes: ['v3.provider.scheduling_projection'],
    produces: ['v3.target.concrete_provider'],
  },
];

for (const expected of expectedEdges) {
  const edge = edges[expected.id]?.[0];
  if (!edge) continue;
  if (edge.from_node !== expected.from || edge.to_node !== expected.to) {
    failures.push(`${expected.id} has the wrong adjacent nodes`);
  }
  if (edge.owner_feature_id !== expected.owner) {
    failures.push(`${expected.id} edge owner must be ${expected.owner}`);
  }
  if (edge.caller_file !== expected.callerFile || edge.callee_file !== expected.calleeFile) {
    failures.push(`${expected.id} caller/callee files do not match the registered modules`);
  }
  for (const [role, file, symbol] of [
    ['caller', expected.callerFile, expected.callerSymbol],
    ['callee', expected.calleeFile, expected.calleeSymbol],
  ]) {
    if (!symbolExists(read(file), symbol)) {
      failures.push(`${expected.id} ${role} symbol is not source-bound: ${symbol}`);
    }
  }
  for (const resourceId of [...expected.consumes, ...expected.produces]) {
    if (!resourceById.has(resourceId)) failures.push(`${expected.id} references unknown resource ${resourceId}`);
  }
}

for (const [resourceId, writers, readers] of [
  ['v3.provider.failure_action', ['build_v3_provider_failure_action_from_v3_error_02'], ['V3ProviderFailureRuntimeHealth::record_provider_key_failure_action']],
  ['v3.provider.key_health_state', ['V3ProviderKeyHealthStore::record_provider_failure_action'], []],
  ['v3.provider.scheduling_projection', ['V3ProviderKeyHealthStore::scheduling_projection'], ['V3TargetInterpreter::select_available_with_health']],
]) {
  const resource = resourceById.get(resourceId);
  if (!resource) continue;
  for (const writer of writers) {
    if (!resource.allowed_writers?.includes(writer)) failures.push(`${resourceId} does not allow writer ${writer}`);
  }
  for (const reader of readers) {
    if (!resource.allowed_readers?.includes(reader)) failures.push(`${resourceId} does not allow reader ${reader}`);
  }
  if (resource.may_enter_provider_body !== false || resource.may_enter_client_body !== false) {
    failures.push(`${resourceId} must stay out of provider and client payloads`);
  }
}

if (failures.length > 0) {
  console.error('[verify:v3-provider-key-health-model-binding] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[verify:v3-provider-key-health-model-binding] ok');
