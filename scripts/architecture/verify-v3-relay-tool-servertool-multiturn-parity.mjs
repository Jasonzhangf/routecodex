#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import YAML from 'yaml';

const files = {
  responseCommon: 'v3/crates/routecodex-v3-runtime/src/hub_v1/common.rs',
  responseChatProcess:
    'v3/crates/routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs',
  responseContinuation:
    'v3/crates/routecodex-v3-runtime/src/hub_v1/resp_continuation_04_committed.rs',
  request: 'v3/crates/routecodex-v3-runtime/src/hub_v1/relay_request.rs',
  responsesRelayRuntime: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs',
  servertoolHooks: 'v3/crates/routecodex-v3-runtime/src/hub_v1/servertool_hooks.rs',
  providerResponsesTransport: 'v3/crates/routecodex-v3-provider-responses/src/transport.rs',
  providerResponsesWire: 'v3/crates/routecodex-v3-provider-responses/src/wire.rs',
  responseSemanticsTests: 'v3/crates/routecodex-v3-runtime/tests/hub_relay_response_semantics.rs',
  requestSemanticsTests: 'v3/crates/routecodex-v3-runtime/tests/hub_relay_request_semantics.rs',
  tests: 'v3/crates/routecodex-v3-runtime/tests/hub_relay_tool_servertool_multiturn_parity.rs',
  responsesLocalTests: 'v3/crates/routecodex-v3-runtime/tests/responses_relay_local_continuation_integration.rs',
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
const responseOwnerSource = [
  text.responseCommon,
  text.responseChatProcess,
  text.responseContinuation,
].join('\n');
const responseSplitOwner =
  'v3/crates/routecodex-v3-runtime/src/hub_v1/{common.rs,resp_chat_process_03_governed.rs,resp_continuation_04_committed.rs}';
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
  'govern_tool_outputs_at_req04',
  'fn normalize_apply_patch_output_text_at_req04',
  'OrphanToolOutput { index: usize, call_id: String }',
  'ToolOutputKindMismatch',
  'SideChannelLeaked',
  'current_payload_start',
]);
forbid(
  text.request,
  files.request,
  /V3HubAttachmentHistoryPolicy|run_with_attachment_history_policy|govern_attachment_history_at_req04|replace_historical_media_with_placeholder/,
  'historical payload rewrite or attachment placeholder owner',
);
forbid(
  text.providerResponsesWire,
  files.providerResponsesWire,
  /replace_historical|remove_configured_historical|historical_tool_image_placeholder|V3_HISTORICAL_TOOL_IMAGE_PLACEHOLDER_TEXT/,
  'provider wire historical payload rewrite or placeholder owner',
);
forbid(
  text.request,
  files.request,
  /full_materialize_govern_tool_outputs_at_req04/,
  'full payload materialization shortcut',
);
requireAll(text.servertoolHooks, files.servertoolHooks, [
  'apply_v3_stopless_request_hook_at_req04',
  'current_payload_start',
  'let current_input = input.get(current_payload_start..)',
  'let current_messages = messages.get(current_payload_start..)',
  'active_stopless_cli_output',
  'active_stopless_chat_cli_output',
  'STOPLESS_CLI_COMMAND',
]);
forbid(
  text.servertoolHooks,
  files.servertoolHooks,
  /strip_active_stopless_pair_and_stale|strip_active_stopless_chat_pair_and_stale|strip_stopless_internal_control_echo|strip_stopless_internal_tools|finalize_stopless_terminal_responses_payload|build_stopless_passthrough_visible_payload|build_stopless_guard_passthrough_visible_payload|lift_additional_tools_into_provider_tool_surface/,
  'history-wide Stopless cleanup or response repair',
);
requireAll(text.providerResponsesTransport, files.providerResponsesTransport, [
  'pub fn is_v3_anthropic_provider_request_header_name',
  'pub struct V3Transport13ResponsesRequest',
]);
forbid(
  text.providerResponsesTransport,
  files.providerResponsesTransport,
  /normalize_responses_additional_tools_for_provider_request|responses_http_provider_request_lifts_additional_tools_to_protocol_tools/,
  'Responses HTTP additional_tools global lift',
);
forbid(
  text.providerResponsesTransport,
  files.providerResponsesTransport,
  /build_anthropic_messages_body|Anthropic protocol conversion/,
  'provider transport protocol conversion outside Chat Process',
);
requireAll(text.responseCommon, files.responseCommon, ['pub enum V3HubRelayToolKind']);
requireAll(text.responseChatProcess, files.responseChatProcess, [
  'pub(crate) fn classify_v3_hub_relay_tool_kind',
  'fn complete_or_repair_v3_resp03_tool_frames',
  'fn inspect_v3_resp03_finish_reason',
  'fn project_v3_apply_patch_freeform_calls_at_resp03',
  'normalize_v3_apply_patch_freeform_input_for_client',
  'tool_call_kinds',
  'SideChannelLeaked',
  'servertool_action',
  'V3HubServertoolResponseAction::FollowupRequired',
]);
requireAll(text.servertoolHooks, files.servertoolHooks, [
  'apply_v3_tool_call_servertool_hook_at_resp03',
  'apply_v3_stop_servertool_hook_at_resp03',
]);
const resp03GovernStart = text.responseChatProcess.indexOf('fn govern_v3_hub_relay_response(');
const resp03GovernEnd = text.responseChatProcess.indexOf('\nstruct V3Resp03ProtocolGovernance', resp03GovernStart);
if (resp03GovernStart < 0 || resp03GovernEnd < 0) {
  fail(`${files.responseChatProcess}: unable to isolate Resp03 response governance orchestrator`);
} else {
  const resp03Govern = text.responseChatProcess.slice(resp03GovernStart, resp03GovernEnd);
  requireOrdered(resp03Govern, files.responseChatProcess, [
    'harvest_v3_think_blocks_at_resp03',
    'complete_or_repair_v3_resp03_tool_frames',
    'inspect_v3_resp03_finish_reason',
    'apply_v3_tool_call_servertool_hook_at_resp03',
    'project_v3_apply_patch_freeform_calls_at_resp03',
    'apply_v3_stop_servertool_hook_at_resp03',
  ], 'Resp03 response governance');
  forbid(
    resp03Govern,
    files.responseChatProcess,
    /apply_v3_stopless_response_hook_at_resp03/,
    'merged stopless response hook in Resp03 orchestrator',
  );
}
requireAll(text.responseContinuation, files.responseContinuation, [
  'canonical_tool_call_kinds',
  'canonical_context_shares_provider_payload',
]);
forbid(
  text.responseContinuation,
  files.responseContinuation,
  /canonicalize_v3_hub_resp04_finalized_payload|finish_reason|finishReason|stop_reason|stopReason|requires_action/,
  'Resp04 semantic repair of status/finish_reason/tool frames',
);
const clientSseProjectionStart = text.responsesRelayRuntime.indexOf(
  'fn build_v3_server_resp_outbound_06_sse_transport_frames_from_resp05',
);
const clientSseProjectionEnd = text.responsesRelayRuntime.indexOf(
  '\nfn project_v3_responses_client_event_output_item_done_item',
  clientSseProjectionStart,
);
if (clientSseProjectionStart < 0 || clientSseProjectionEnd < 0) {
  fail(`${files.responsesRelayRuntime}: unable to isolate Responses client SSE projection owner`);
} else {
  const clientSseProjection = text.responsesRelayRuntime.slice(
    clientSseProjectionStart,
    clientSseProjectionEnd,
  );
  requireAll(clientSseProjection, files.responsesRelayRuntime, [
    'Some("failed" | "incomplete")',
    '"response.failed"',
    '"response.completed"',
    '"response.done"',
    'b"data: [DONE]\\n\\n"',
  ]);
  requireOrdered(clientSseProjection, files.responsesRelayRuntime, [
    '"response.completed"',
    '"response.done"',
    'b"data: [DONE]\\n\\n"',
  ]);
  forbid(
    clientSseProjection,
    files.responsesRelayRuntime,
    /"response\.requires_action"/,
    'response.requires_action client SSE terminal projection',
  );
}
forbid(
  text.responsesRelayRuntime,
  files.responsesRelayRuntime,
  /v3_runtime_sse_event_has_tool_call|v3_runtime_sse_item_is_tool_call/,
  'SSE transport tool-call semantic inference',
);

const runFromNormalizedStart = text.request.indexOf('pub fn run_from_normalized(');
const req04Start = text.request.indexOf('fn run_from_normalized_with_events');
const classifyStart = text.request.indexOf('fn classify_continuation');
if (
  runFromNormalizedStart < 0 ||
  req04Start < 0 ||
  classifyStart < 0 ||
  !(runFromNormalizedStart < req04Start && req04Start < classifyStart)
) {
  fail(`${files.request}: unable to isolate Req04 request governance owner`);
} else {
  const req04Owner = text.request.slice(req04Start, classifyStart);
  requireOrdered(req04Owner, files.request, [
    'restore_local_context_at_req04',
    'current_payload_start',
    'govern_tool_outputs_at_req04',
    'run_servertool_profile',
  ]);
}
requireAll(text.tests, files.tests, [
  'protocol_transport_continuation_matrix_uses_one_chat_process_governance_path',
  'request_governance_matches_function_custom_servertool_and_internal_tool_outputs_to_restored_context',
  'apply_patch_response_is_projected_to_freeform_custom_tool_before_commit',
  'apply_patch_tool_output_error_is_normalized_and_kept_as_next_turn_tool_output',
  'apply_patch_legacy_function_call_accepts_custom_output_after_client_projection',
  'request_governance_rejects_orphan_output_wrong_kind_and_missing_call_id',
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
  'attachment_history_is_preserved_without_placeholder_cleanup',
  'attachment_history_missing_resource_is_preserved_as_client_data',
  'stopless_shaped_business_text_is_preserved_without_current_turn_activation',
  'malformed_current_turn_reasoning_stop_arguments_fail_without_guessing_control_state',
]);
requireAll(text.responseSemanticsTests, files.responseSemanticsTests, [
  'resp03_repairs_tool_call_finish_reason_before_stop_servertool_hook',
  'resp04_reuses_resp03_repaired_payload_without_semantic_repair',
]);
requireAll(text.requestSemanticsTests, files.requestSemanticsTests, [
  'stopless_req04_ignores_restored_history_and_only_observes_current_suffix',
]);
requireAll(text.functionMap, files.functionMap, [
  'feature_id: v3.resp03_tool_governance_gap_closeout',
  'complete_or_repair_v3_resp03_tool_frames',
  'apply_v3_tool_call_servertool_hook_at_resp03',
  'apply_v3_stop_servertool_hook_at_resp03',
]);
requireAll(text.mainlineMap, files.mainlineMap, [
  'chain_id: v3.resp03_tool_governance_gap_closeout',
  'v3-resp03-tool-governance-01',
  'v3-resp03-tool-governance-06',
]);
requireAll(text.verificationMap, files.verificationMap, [
  'feature_id: v3.resp03_tool_governance_gap_closeout',
  'Resp04 reuses Resp03 governed provider payload',
]);
requireAll(text.responsesLocalTests, files.responsesLocalTests, [
  'json_two_turn_restores_tool_call_pairs_output_and_preserves_tools',
  'json_two_turn_apply_patch_uses_freeform_projection_and_error_feedback',
  'wrong_tool_output_id_fails_before_provider_send_and_keeps_saved_context',
  'assert_eq!(transport.captures.lock().unwrap().len(), 1);',
  'json_two_turn_preserves_responses_additional_tools_surface_and_tool_result_pairs',
  'json_stopless_center_natural_stop_guard_passes_cleaned_original_response',
  'Responses Relay client SSE must not use response.requires_action as the terminal stream event',
  'no-original-tools request must not synthesize Responses input.additional_tools',
]);

requireAll(text.functionMap, files.functionMap, [featureId, lifecycleId]);
requireAll(text.mainlineMap, files.mainlineMap, [featureId, lifecycleId, ...requiredSteps]);
requireAll(text.verificationMap, files.verificationMap, [featureId, lifecycleId]);
requireAll(text.resourceMap, files.resourceMap, [featureId]);
requireAll(text.wiki, files.wiki, [featureId, lifecycleId, 'v3-relay-tool-parity-01']);

requireAll(text.resourceMap, files.resourceMap, [
  'v3.hub.tool_governance_truth',
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

const requestWrongOwnerAuditSource = stripStringLiterals(text.request);
const responseWrongOwnerAuditSource = stripStringLiterals(responseOwnerSource);
forbid(requestWrongOwnerAuditSource, files.request, /handler|server_frame|provider_runtime|transport_socket|websocket/i, 'wrong owner repair vocabulary in request governance');
forbid(responseWrongOwnerAuditSource, responseSplitOwner, /handler|server_frame|provider_runtime|transport_socket|websocket/i, 'wrong owner repair vocabulary in response governance');
forbid(text.request + responseOwnerSource, 'V3 Relay tool parity Rust owner', /read_dir|libloading/i, 'dynamic filesystem hook');
forbid(text.request + responseOwnerSource, 'V3 Relay tool parity Rust owner', /metadata_center(?!_local_search)[\s\S]{0,120}(?:insert|write|payload)|payload[\s\S]{0,120}metadata_center(?!_local_search)/i, 'MetadataCenter payload/control leakage');
forbid(text.tests, files.tests, /fallback/i, 'fallback in parity tests');
forbid(text.responsesLocalTests, files.responsesLocalTests, /fallback/i, 'fallback in Responses Relay local continuation tests');

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

function requireOrdered(source, owner, phrases, label = 'Req04') {
  let previousIndex = -1;
  for (const phrase of phrases) {
    const index = source.indexOf(phrase);
    if (index < 0) {
      fail(`${owner}: missing ordered ${label} step ${phrase}`);
      return;
    }
    if (index <= previousIndex) {
      fail(`${owner}: ${label} step out of order ${phrase}`);
      return;
    }
    previousIndex = index;
  }
}

function stripStringLiterals(source) {
  return source.replace(/"(?:\\.|[^"\\])*"/g, '""');
}

function fail(message) {
  failures.push(message);
}
