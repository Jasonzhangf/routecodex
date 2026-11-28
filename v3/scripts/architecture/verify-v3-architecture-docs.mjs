import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const root = process.env.ROUTECODEX_V3_SOURCE_ROOT
  ? path.resolve(process.env.ROUTECODEX_V3_SOURCE_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const failures = [];
const fail = (message) => failures.push(message);
const array = (value) => Array.isArray(value) ? value : [];
const yaml = (file) => {
  try { return YAML.parse(fs.readFileSync(path.join(root, file), 'utf8')) ?? {}; }
  catch (error) { fail(`${file}: cannot read/parse: ${error.message}`); return {}; }
};
const resourceMap = yaml('docs/architecture/v3-resource-operation-map.yml');
const functionMap = yaml('docs/architecture/v3-function-map.yml');
const mainlineMap = yaml('docs/architecture/v3-mainline-call-map.yml');
const verificationMap = yaml('docs/architecture/v3-verification-map.yml');
if (resourceMap.version !== 2) fail('v3-resource-operation-map.yml: version must be 2');
if (functionMap.version !== 1) fail('v3-function-map.yml: version must be 1');
if (mainlineMap.version !== 2) fail('v3-mainline-call-map.yml: version must be 2');
if (verificationMap.version !== 2) fail('v3-verification-map.yml: version must be 2');

// These are declared payload permissions, not assertions about prose or Rust
// expression spelling. Actual runtime behavior is covered by its consumers.
const clientBodyProjectionResources = new Set([
  'v3.response.client_payload', 'v3.models.capability_catalog',
]);
const resourceIds = new Set();
for (const [index, resource] of array(resourceMap.resources).entries()) {
  const where = `resource[${index}]`;
  if (!resource?.resource_id?.startsWith('v3.')) fail(`${where}: invalid resource_id`);
  if (resourceIds.has(resource.resource_id)) fail(`${where}: duplicate ${resource.resource_id}`);
  resourceIds.add(resource.resource_id);
  for (const field of ['resource_kind', 'lifecycle', 'owner_crate', 'owner_node', 'binding_status']) {
    if (typeof resource[field] !== 'string' || !resource[field]) fail(`${where}: missing ${field}`);
  }
  for (const field of ['identity', 'allowed_writers', 'allowed_readers', 'forbidden_writers']) {
    if (!Array.isArray(resource[field]) || resource[field].length === 0) fail(`${where}: missing ${field}`);
  }
  if (!['normal_payload', 'provider_wire', 'transport'].includes(resource.resource_kind)
      && resource.may_enter_provider_body !== false) fail(`${where}: control resource may enter provider body`);
  if (!clientBodyProjectionResources.has(resource.resource_id) && resource.may_enter_client_body === true) {
    fail(`${where}: unexpected client body permission`);
  }
}

const chains = array(mainlineMap.chains);
for (const chainId of [
  'v3.config.compile', 'v3.responses_direct.required_mainline',
  'v3.hub_pipeline.v1.request', 'v3.hub_pipeline.v1.response',
]) {
  if (!chains.some((chain) => chain.chain_id === chainId)) fail(`mainline: missing chain ${chainId}`);
}
const allEdges = chains.flatMap((chain) => array(chain.edges));
if (allEdges.some((edge) => edge.from_node === 'V3Target10ConcreteProviderSelected'
    && edge.to_node === 'V3ResponsesDirect11Policy')) {
  fail('mainline: forbidden Responses Direct shortcut; V3Execution11ProtocolDecision owns the decision edge');
}
const hubV1EdgePairs = new Map([
  ['v3-hub-req-01', ['V3HubReqInbound01ClientRaw', 'V3HubReqInbound02Normalized']],
  ['v3-hub-req-02', ['V3HubReqInbound02Normalized', 'V3HubReqChatProcess04Governed']],
  ['v3-hub-req-03', ['V3HubReqChatProcess04Governed', 'V3HubReqExecution05Planned']],
  ['v3-hub-req-04', ['V3HubReqExecution05Planned', 'V3HubReqTarget06Resolved']],
  ['v3-hub-req-05', ['V3HubReqTarget06Resolved', 'V3HubReqOutbound07ProviderSemantic']],
  ['v3-hub-req-06', ['V3HubReqOutbound07ProviderSemantic', 'ProviderReqCompat06ProviderCompat']],
  ['v3-hub-req-07', ['ProviderReqCompat06ProviderCompat', 'V3ProviderReqOutbound08WirePayload']],
  ['v3-hub-req-08', ['V3ProviderReqOutbound08WirePayload', 'V3ProviderReqOutbound09TransportRequest']],
  ['v3-hub-resp-01', ['V3ProviderRespInbound01Raw', 'ProviderRespCompat02ProviderCompat']],
  ['v3-hub-resp-02', ['ProviderRespCompat02ProviderCompat', 'V3HubRespInbound02Normalized']],
  ['v3-hub-resp-03', ['V3HubRespInbound02Normalized', 'V3HubRespChatProcess03Governed']],
  ['v3-hub-resp-04', ['V3HubRespChatProcess03Governed', 'V3HubRespOutbound05ClientSemantic']],
  ['v3-hub-resp-05', ['V3HubRespOutbound05ClientSemantic', 'V3ServerRespOutbound06ClientFrame']],
]);
for (const [stepId, [fromNode, toNode]] of hubV1EdgePairs) {
  const edge = allEdges.find((candidate) => candidate.step_id === stepId);
  if (!edge) fail(`mainline: missing Hub v1 edge ${stepId}`);
  else if (edge.from_node !== fromNode || edge.to_node !== toNode) {
    fail(`mainline: ${stepId} must remain adjacent ${fromNode} -> ${toNode}`);
  }
}
for (const [index, edge] of allEdges.entries()) {
  const where = `edge[${index}]`;
  if (!edge.step_id || !edge.from_node || !edge.to_node || !edge.owner_feature_id) fail(`${where}: incomplete identity`);
  if (!['anchored', 'runtime_bound', 'binding_pending', 'as_is_bound', 'obsolete'].includes(edge.status)) fail(`${where}: invalid status ${edge.status}`);
  for (const field of ['consumes', 'produces', 'side_channel_reads', 'side_channel_writes']) {
    for (const resourceId of array(edge.resource_flow?.[field])) {
      if (!resourceIds.has(resourceId)) fail(`${where}: undeclared resource ${resourceId}`);
    }
  }
}

for (const featureId of [
  'v3.hub_relay_request_semantics', 'v3.hub_relay_response_semantics',
  'v3.hub_relay_runtime_resources_hooks', 'v3.hub_relay_gate_review_surface',
]) {
  const functionFeature = array(functionMap.features).find((entry) => entry.feature_id === featureId);
  const verificationFeature = array(verificationMap.features).find((entry) => entry.feature_id === featureId);
  if (!functionFeature) {
    fail(`Relay worker map: function map missing ${featureId}`);
    continue;
  }
  if (!verificationFeature) fail(`Relay worker map: verification map missing ${featureId}`);
  for (const field of ['resource_bindings', 'mainline_bindings', 'allowed_paths', 'forbidden_paths']) {
    if (array(functionFeature[field]).length === 0) fail(`Relay worker map: ${featureId} missing ${field}`);
  }
  for (const resourceId of array(functionFeature.resource_bindings)) {
    if (!resourceIds.has(resourceId)) fail(`Relay worker map: ${featureId} binds undeclared resource ${resourceId}`);
  }
  for (const stepId of array(functionFeature.mainline_bindings)) {
    if (!allEdges.some((edge) => edge.step_id === stepId)) {
      fail(`Relay worker map: ${featureId} binds missing mainline step ${stepId}`);
    }
  }
}

const attemptProjectionCtx = array(resourceMap.resources).find(
  (entry) => entry?.resource_id === 'v3.operation_runner.attempt_projection_context',
);
if (!attemptProjectionCtx) {
  fail('v3-resource-operation-map.yml: missing v3.operation_runner.attempt_projection_context');
} else {
  if (!String(attemptProjectionCtx.semantic_contract?.orphan_tool_output_literals ?? '').trim()) {
    fail('v3-resource-operation-map.yml: v3.operation_runner.attempt_projection_context must declare semantic_contract.orphan_tool_output_literals');
  }
  for (const writer of ['project_v3_operation_runner_standard_provider_request', 'build_v3_hub_req_outbound_07_from_v3_hub_req_target_06']) {
    if (!array(attemptProjectionCtx.allowed_writers).includes(writer)) {
      fail(`v3-resource-operation-map.yml: v3.operation_runner.attempt_projection_context allowed_writers missing ${writer}`);
    }
  }
  for (const reader of ['adjust_provider_private_request', 'build_provider_req_compat_06_from_v3_hub_req_outbound_07']) {
    if (!array(attemptProjectionCtx.allowed_readers).includes(reader)) {
      fail(`v3-resource-operation-map.yml: v3.operation_runner.attempt_projection_context allowed_readers missing ${reader}`);
    }
  }
}

for (const [stepId, field] of [
  ['v3-op-runner-req-05', 'produces'],
  ['v3-op-runner-req-05', 'side_channel_writes'],
  ['v3-op-runner-req-06', 'consumes'],
  ['v3-op-runner-req-06', 'side_channel_reads'],
  ['v3-hub-req-05', 'side_channel_writes'],
  ['v3-hub-req-06', 'consumes'],
  ['v3-hub-req-06', 'side_channel_reads'],
]) {
  const edge = allEdges.find((candidate) => candidate?.step_id === stepId);
  if (!edge || !array(edge.resource_flow?.[field]).includes('v3.operation_runner.attempt_projection_context')) {
    fail(`v3-mainline-call-map.yml: ${stepId} resource_flow.${field} must declare v3.operation_runner.attempt_projection_context`);
  }
}

const explicitHistoryPairing = array(resourceMap.resources).find(
  (entry) => entry?.resource_id === 'v3.operation_runner.explicit_history_pairing',
);
if (!explicitHistoryPairing) {
  fail('v3-resource-operation-map.yml: missing v3.operation_runner.explicit_history_pairing');
} else {
  if (!String(explicitHistoryPairing.semantic_contract?.req04_orphan_rule ?? '').trim()) {
    fail('v3-resource-operation-map.yml: v3.operation_runner.explicit_history_pairing must declare semantic_contract.req04_orphan_rule');
  }
  for (const writer of [
    'normalize_v3_operation_runner_request_losslessly',
    'govern_v3_operation_runner_chat_request',
    'govern_chat_request_at_req04',
  ]) {
    if (!array(explicitHistoryPairing.allowed_writers).includes(writer)) {
      fail(`v3-resource-operation-map.yml: v3.operation_runner.explicit_history_pairing allowed_writers missing ${writer}`);
    }
  }
  for (const reader of [
    'govern_v3_operation_runner_chat_request',
    'project_v3_operation_runner_standard_provider_request',
    'build_v3_hub_req_outbound_07_from_v3_hub_req_target_06',
  ]) {
    if (!array(explicitHistoryPairing.allowed_readers).includes(reader)) {
      fail(`v3-resource-operation-map.yml: v3.operation_runner.explicit_history_pairing allowed_readers missing ${reader}`);
    }
  }
}

for (const [stepId, field] of [
  ['v3-op-runner-req-04', 'produces'],
  ['v3-op-runner-req-04', 'side_channel_writes'],
  ['v3-op-runner-req-05', 'consumes'],
  ['v3-op-runner-req-05', 'side_channel_reads'],
  ['v3-hub-req-05', 'consumes'],
  ['v3-hub-req-05', 'side_channel_reads'],
]) {
  const edge = allEdges.find((candidate) => candidate?.step_id === stepId);
  if (!edge || !array(edge.resource_flow?.[field]).includes('v3.operation_runner.explicit_history_pairing')) {
    fail(`v3-mainline-call-map.yml: ${stepId} resource_flow.${field} must declare v3.operation_runner.explicit_history_pairing`);
  }
}

const requestDagPath = path.join(root, 'docs/architecture/dagpipe/v3.operation_runner.request.graph.json');
if (fs.existsSync(requestDagPath)) {
  try {
    const requestDag = JSON.parse(fs.readFileSync(requestDagPath, 'utf8'));
    const nodesById = new Map(array(requestDag.nodes).map((node) => [node?.id, node]));
    const governNode = nodesById.get('govern_chat_request');
    const projNode = nodesById.get('project_standard_provider_request');
    const compatNode = nodesById.get('adjust_provider_private_request');
    if (!array(governNode?.resources?.writes).includes('v3.operation_runner.explicit_history_pairing')) {
      fail('docs/architecture/dagpipe/v3.operation_runner.request.graph.json: govern_chat_request must write v3.operation_runner.explicit_history_pairing');
    }
    if (!array(projNode?.resources?.reads).includes('v3.operation_runner.explicit_history_pairing')) {
      fail('docs/architecture/dagpipe/v3.operation_runner.request.graph.json: project_standard_provider_request must read v3.operation_runner.explicit_history_pairing');
    }
    if (!array(projNode?.resources?.writes).includes('v3.operation_runner.attempt_projection_context')) {
      fail('docs/architecture/dagpipe/v3.operation_runner.request.graph.json: project_standard_provider_request must write v3.operation_runner.attempt_projection_context');
    }
    if (!array(compatNode?.resources?.reads).includes('v3.operation_runner.attempt_projection_context')) {
      fail('docs/architecture/dagpipe/v3.operation_runner.request.graph.json: adjust_provider_private_request must read v3.operation_runner.attempt_projection_context');
    }
  } catch (error) {
    fail(`docs/architecture/dagpipe/v3.operation_runner.request.graph.json: cannot read/parse: ${error.message}`);
  }
}

if (failures.length) {
  console.error('[verify:v3-architecture-docs] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(`[verify:v3-architecture-docs] ok (${resourceIds.size} resources, ${allEdges.length} edges)`);
