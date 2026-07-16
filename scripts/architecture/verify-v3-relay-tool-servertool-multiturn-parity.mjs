#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import YAML from 'yaml';

const files = {
  response: 'v3/crates/routecodex-v3-runtime/src/hub_v1.rs',
  request: 'v3/crates/routecodex-v3-runtime/src/hub_v1/relay_request.rs',
  tests: 'v3/crates/routecodex-v3-runtime/tests/hub_relay_tool_servertool_multiturn_parity.rs',
  manifest: 'docs/architecture/manifests/v3.hub_relay.tool_servertool_multiturn_parity.mainline.yml',
  functionMap: 'docs/architecture/v3-function-map.yml',
  mainlineMap: 'docs/architecture/v3-mainline-call-map.yml',
  verificationMap: 'docs/architecture/v3-verification-map.yml',
  resourceMap: 'docs/architecture/v3-resource-operation-map.yml',
  wiki: 'docs/architecture/wiki/v3-hub-relay-fixed-pipeline.md',
  packageJson: 'package.json',
};

const text = Object.fromEntries(
  Object.entries(files).map(([key, path]) => [key, readFileSync(path, 'utf8')]),
);
const manifest = YAML.parse(text.manifest);
const packageJson = JSON.parse(text.packageJson);
const failures = [];

const featureId = 'v3.relay_tool_servertool_multiturn_parity_closeout';
const lifecycleId = 'v3.hub_relay.tool_servertool_multiturn_parity';
const requiredScripts = [
  'test:v3-relay-tool-servertool-multiturn-parity-closeout',
  'verify:v3-relay-tool-servertool-multiturn-parity-closeout',
  'test:v3-relay-tool-servertool-multiturn-parity-closeout-red-fixtures',
];
const supportingProtocolScripts = [
  'test:v3-anthropic-codec-characterization',
  'test:v3-openai-chat-codec-characterization',
  'test:v3-gemini-codec-characterization',
];
const requiredSteps = [
  'v3-relay-tool-parity-01',
  'v3-relay-tool-parity-02',
  'v3-relay-tool-parity-03',
  'v3-relay-tool-parity-04',
  'v3-relay-tool-parity-05',
  'v3-relay-tool-parity-06',
];

if (manifest.lifecycle_id !== lifecycleId) fail(`${files.manifest}: lifecycle_id mismatch`);
if (manifest.owner_feature_id !== featureId) fail(`${files.manifest}: owner_feature_id mismatch`);
if (manifest.call_map_chain_id !== lifecycleId) fail(`${files.manifest}: call_map_chain_id mismatch`);
if (!Array.isArray(manifest.edges) || manifest.edges.length !== requiredSteps.length) {
  fail(`${files.manifest}: expected ${requiredSteps.length} parity edges`);
} else {
  for (const [index, step] of requiredSteps.entries()) {
    const edge = manifest.edges[index];
    if (edge?.step_id !== step || edge.owner_feature_id !== featureId || edge.status !== 'anchored') {
      fail(`${files.manifest}: edge ${step} mismatch`);
    }
  }
}

for (const script of requiredScripts) {
  if (!packageJson.scripts?.[script]) fail(`${files.packageJson}: missing script ${script}`);
}

requireAll(text.request, files.request, [
  'V3HubAttachmentHistoryPolicy',
  'run_with_attachment_history_policy',
  'govern_tool_outputs_at_req04',
  'govern_attachment_history_at_req04',
  'pub enum V3HubAttachmentHistoryPolicy',
  'OrphanToolOutput { index: usize, call_id: String }',
  'ToolOutputKindMismatch',
  'AttachmentResourceMissing',
  'SideChannelLeaked',
  'replace_historical_media_with_placeholder',
]);
requireAll(text.response, files.response, [
  'pub enum V3HubRelayToolKind',
  'pub(crate) fn classify_v3_hub_relay_tool_kind',
  'tool_call_kinds',
  'canonical_tool_call_kinds',
  'SideChannelLeaked',
  'servertool_action',
  'V3HubServertoolResponseAction::FollowupRequired',
]);

const runWithStart = text.request.indexOf('pub fn run_with_attachment_history_policy');
const runFromNormalizedStart = text.request.indexOf('pub fn run_from_normalized(');
const req04Start = text.request.indexOf('fn run_from_normalized_with_events');
const classifyStart = text.request.indexOf('fn classify_continuation');
if (
  runWithStart < 0 ||
  runFromNormalizedStart < 0 ||
  req04Start < 0 ||
  classifyStart < 0 ||
  !(runWithStart < runFromNormalizedStart && runFromNormalizedStart < req04Start && req04Start < classifyStart)
) {
  fail(`${files.request}: unable to isolate Req04 request governance owner`);
} else {
  const preReq04 = text.request.slice(runWithStart, runFromNormalizedStart);
  const req04Owner = text.request.slice(req04Start, classifyStart);
  forbid(
    preReq04,
    files.request,
    /govern_attachment_history_at_req04\s*\(/,
    'attachment history governance before Req04',
  );
  requireOrdered(req04Owner, files.request, [
    'restore_local_context_at_req04',
    'govern_tool_outputs_at_req04',
    'govern_attachment_history_at_req04',
    'run_servertool_profile',
  ]);
}
requireAll(text.tests, files.tests, [
  'protocol_transport_continuation_matrix_uses_one_chat_process_governance_path',
  'request_governance_matches_function_custom_servertool_and_internal_tool_outputs_to_restored_context',
  'request_governance_rejects_orphan_output_wrong_kind_and_missing_call_id',
  'attachment_history_placeholder_releases_only_historical_media_and_preserves_current_payload',
  'attachment_history_missing_resource_fails_without_trimming_current_request',
  'response_governance_classifies_function_custom_servertool_and_internal_tools_before_commit',
  'responses_sse_arbitrary_chunks_preserve_delta_order_and_terminal_tool_order',
  'provider_and_client_payloads_reject_routecodex_control_leakage',
  'V3HubRelayToolKind::ApplyPatch',
  'V3HubRelayToolKind::Mcp',
  'V3HubRelayToolKind::Native',
  'V3HubEntryProtocol::Anthropic',
  'V3HubEntryProtocol::OpenAiChat',
  'V3HubEntryProtocol::Gemini',
  'V3HubTransportIntent::Sse',
  'V3HubContinuationOwnership::RemoteProviderOwned',
  'V3HubContinuationOwnership::RouteCodexLocalOwned',
  'data:image/png;base64,CURRENT',
]);

requireAll(text.functionMap, files.functionMap, [featureId, lifecycleId]);
requireAll(text.mainlineMap, files.mainlineMap, [featureId, lifecycleId, ...requiredSteps]);
requireAll(text.verificationMap, files.verificationMap, [featureId, lifecycleId]);
requireAll(text.resourceMap, files.resourceMap, [featureId]);
requireAll(text.wiki, files.wiki, [featureId, lifecycleId, 'v3-relay-tool-parity-01']);

requireAll(text.resourceMap, files.resourceMap, [
  'v3.hub.tool_governance_truth',
  'v3.hub.attachment_history_placeholder',
]);
for (const script of requiredScripts) {
  requireAll(text.functionMap, files.functionMap, [`npm run ${script}`]);
  requireAll(text.verificationMap, files.verificationMap, [`npm run ${script}`]);
}
for (const script of supportingProtocolScripts) {
  if (!packageJson.scripts?.[script]) fail(`${files.packageJson}: missing script ${script}`);
  requireAll(text.verificationMap, files.verificationMap, [`npm run ${script}`]);
  requireAll(text.wiki, files.wiki, [`npm run ${script}`]);
}

const responseOwnerSource = text.response.split('#[cfg(test)]')[0];
forbid(text.request, files.request, /handler|server_frame|provider_runtime|transport_socket|websocket/i, 'wrong owner repair vocabulary in request governance');
forbid(responseOwnerSource, files.response, /handler|server_frame|provider_runtime|transport_socket|websocket/i, 'wrong owner repair vocabulary in response governance');
forbid(text.request + text.response, 'V3 Relay tool parity Rust owner', /fallback|full_materiali[sz]e|collect\s*::<\s*Vec|read_dir|libloading/i, 'fallback/materialization/dynamic hook');
forbid(text.request + text.response, 'V3 Relay tool parity Rust owner', /metadata_center[\s\S]{0,120}(?:insert|write|payload)|payload[\s\S]{0,120}metadata_center/i, 'MetadataCenter payload/control leakage');
forbid(text.tests, files.tests, /fallback/i, 'fallback in parity tests');

if (failures.length) {
  console.error('[verify:v3-relay-tool-servertool-multiturn-parity-closeout] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('[verify:v3-relay-tool-servertool-multiturn-parity-closeout] ok');

function requireAll(source, owner, phrases) {
  for (const phrase of phrases) {
    if (!source.includes(phrase)) fail(`${owner}: missing ${phrase}`);
  }
}

function forbid(source, owner, pattern, label) {
  if (pattern.test(source)) fail(`${owner}: forbidden ${label} (${pattern})`);
}

function requireOrdered(source, owner, phrases) {
  let previousIndex = -1;
  for (const phrase of phrases) {
    const index = source.indexOf(phrase);
    if (index < 0) {
      fail(`${owner}: missing ordered Req04 step ${phrase}`);
      return;
    }
    if (index <= previousIndex) {
      fail(`${owner}: Req04 step out of order ${phrase}`);
      return;
    }
    previousIndex = index;
  }
}

function fail(message) {
  failures.push(message);
}
