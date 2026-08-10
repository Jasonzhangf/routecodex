#!/usr/bin/env node
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = process.cwd();
const verifier = resolve(repo, 'scripts/architecture/verify-v3-relay-tool-servertool-multiturn-parity.mjs');
const copyPaths = [
  'v3/crates/routecodex-v3-runtime/src/hub_v1/common.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/resp_continuation_04_committed.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/relay_request.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/servertool_hooks.rs',
  'v3/crates/routecodex-v3-provider-responses/src/transport.rs',
  'v3/crates/routecodex-v3-provider-responses/src/wire.rs',
  'v3/crates/routecodex-v3-runtime/tests/hub_relay_response_semantics.rs',
  'v3/crates/routecodex-v3-runtime/tests/hub_relay_request_semantics.rs',
  'v3/crates/routecodex-v3-runtime/tests/hub_relay_tool_servertool_multiturn_parity.rs',
  'v3/crates/routecodex-v3-runtime/tests/responses_relay_local_continuation_integration.rs',
  'docs/architecture/manifests/v3.hub_relay.tool_servertool_multiturn_parity.mainline.yml',
  'docs/architecture/v3-resource-operation-map.yml',
  'docs/architecture/v3-function-map.yml',
  'docs/architecture/v3-mainline-call-map.yml',
  'docs/architecture/v3-verification-map.yml',
  'docs/architecture/wiki/v3-hub-relay-fixed-pipeline.md',
  'package.json',
];

const cases = [
  {
    name: 'provider wire historical placeholder revived',
    file: 'v3/crates/routecodex-v3-provider-responses/src/wire.rs',
    marker: 'use serde_json::{Map, Value};\n',
    mutation:
      'fn replace_historical_responses_tool_output_data_images() {}\nuse serde_json::{Map, Value};\n',
    diagnostic: /provider wire historical payload rewrite or placeholder owner/,
  },
  {
    name: 'orphan tool output fail-fast removed',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/relay_request.rs',
    marker: 'OrphanToolOutput { index: usize, call_id: String }',
    mutation: 'MissingOrphanOutput { index: usize, call_id: String }',
    diagnostic: /OrphanToolOutput/,
  },
  {
    name: 'attachment history placeholder policy revived',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/relay_request.rs',
    marker: 'use serde_json::Value;\n',
    mutation: 'enum V3HubAttachmentHistoryPolicy { Placeholder }\nuse serde_json::Value;\n',
    diagnostic: /historical payload rewrite or attachment placeholder owner/,
  },
  {
    name: 'attachment history governance moved before Req04',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/relay_request.rs',
    marker: 'merge_v3_relay_restored_local_context_at_req04(',
    mutation: 'govern_attachment_history_at_req04(&mut serde_json::Value::Null);\nmerge_v3_relay_restored_local_context_at_req04(',
    diagnostic: /historical payload rewrite or attachment placeholder owner/,
  },
  {
    name: 'tool kind classifier removed',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs',
    marker: 'pub(crate) fn classify_v3_hub_relay_tool_kind',
    mutation: 'pub(crate) fn classify_tool_kind_removed',
    diagnostic: /classify_v3_hub_relay_tool_kind/,
  },
  {
    name: 'apply_patch response freeform projection removed',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs',
    marker: 'fn project_v3_apply_patch_freeform_calls_at_resp03',
    mutation: 'project_v3_apply_patch_projection_removed',
    diagnostic: /project_v3_apply_patch_freeform_calls_at_resp03/,
  },
  {
    name: 'Resp04 semantic repair revived',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/resp_continuation_04_committed.rs',
    marker: 'pub(crate) fn commit_v3_hub_relay_response',
    mutation:
      'fn canonicalize_v3_hub_resp04_finalized_payload() { let _ = "finish_reason requires_action"; }\npub(crate) fn commit_v3_hub_relay_response',
    diagnostic: /Resp04 semantic repair|canonicalize_v3_hub_resp04_finalized_payload/,
  },
  {
    name: 'Resp03 repair step removed',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs',
    marker: 'complete_or_repair_v3_resp03_tool_frames',
    mutation: 'resp03_tool_frame_repair_removed',
    diagnostic: /complete_or_repair_v3_resp03_tool_frames|Resp03 response governance/,
  },
  {
    name: 'Resp03 finish reason inspector removed',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs',
    marker: 'inspect_v3_resp03_finish_reason',
    mutation: 'resp03_finish_reason_inspector_removed',
    diagnostic: /inspect_v3_resp03_finish_reason|Resp03 response governance/,
  },
  {
    name: 'tool-call servertool hook removed',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/servertool_hooks.rs',
    marker: 'apply_v3_tool_call_servertool_hook_at_resp03',
    mutation: 'apply_v3_tool_call_servertool_hook_removed_at_resp03',
    all: true,
    diagnostic: /apply_v3_tool_call_servertool_hook_at_resp03/,
  },
  {
    name: 'stop servertool hook removed',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/servertool_hooks.rs',
    marker: 'apply_v3_stop_servertool_hook_at_resp03',
    mutation: 'apply_v3_stop_servertool_hook_removed_at_resp03',
    all: true,
    diagnostic: /apply_v3_stop_servertool_hook_at_resp03/,
  },
  {
    name: 'Responses client SSE completed terminal relabeled as requires_action',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs',
    marker:
      'frames.push(Ok(build_v3_runtime_sse_json_frame(\n            "response.completed",',
    mutation:
      'frames.push(Ok(build_v3_runtime_sse_json_frame(\n            "response.requires_action",',
    diagnostic: /response\.completed|response\.requires_action client SSE terminal projection/,
  },
  {
    name: 'Responses client SSE done terminal removed',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs',
    marker:
      'frames.push(Ok(build_v3_runtime_sse_json_frame(\n            "response.done",\n            &json!({\n                "type": "response.done",',
    mutation:
      'frames.push(Ok(build_v3_runtime_sse_json_frame(\n            "response.closed",\n            &json!({\n                "type": "response.closed",',
    diagnostic: /response\.done/,
  },
  {
    name: 'SSE transport revives tool-call semantic finish inference',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs',
    marker: 'fn infer_v3_runtime_finish_reason(',
    mutation:
      'fn v3_runtime_sse_event_has_tool_call() {}\nfn infer_v3_runtime_finish_reason(',
    diagnostic: /SSE transport tool-call semantic inference/,
  },
  {
    name: 'apply_patch request feedback normalization removed',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/relay_request.rs',
    marker: 'fn normalize_apply_patch_output_text_at_req04',
    mutation: 'normalize_apply_patch_output_removed_at_req04',
    diagnostic: /normalize_apply_patch_output_text_at_req04/,
  },
  {
    name: 'protocol transport continuation matrix removed',
    file: 'v3/crates/routecodex-v3-runtime/tests/hub_relay_tool_servertool_multiturn_parity.rs',
    marker: 'protocol_transport_continuation_matrix_uses_one_chat_process_governance_path',
    mutation: 'protocol_transport_continuation_matrix_removed',
    diagnostic: /protocol_transport_continuation_matrix_uses_one_chat_process_governance_path/,
  },
  {
    name: 'focused parity test removed',
    file: 'v3/crates/routecodex-v3-runtime/tests/hub_relay_tool_servertool_multiturn_parity.rs',
    marker: 'request_governance_rejects_orphan_output_wrong_kind_and_missing_call_id',
    mutation: 'request_governance_missing_negative_case',
    diagnostic: /request_governance_rejects_orphan_output_wrong_kind_and_missing_call_id/,
  },
  {
    name: 'Responses Relay provider tools preservation removed',
    file: 'v3/crates/routecodex-v3-runtime/tests/responses_relay_local_continuation_integration.rs',
    marker: 'json_two_turn_preserves_responses_additional_tools_surface_and_tool_result_pairs',
    mutation: 'json_two_turn_additional_tools_surface_test_removed',
    diagnostic: /json_two_turn_preserves_responses_additional_tools_surface_and_tool_result_pairs/,
  },
  {
    name: 'Codex additional_tools shape blackbox removed',
    file: 'v3/crates/routecodex-v3-runtime/tests/responses_relay_local_continuation_integration.rs',
    marker: 'json_two_turn_preserves_responses_additional_tools_surface_and_tool_result_pairs',
    mutation: 'json_two_turn_additional_tools_shape_test_removed',
    diagnostic: /json_two_turn_preserves_responses_additional_tools_surface_and_tool_result_pairs/,
  },
  {
    name: 'stopless natural-stop guard client semantic blackbox removed',
    file: 'v3/crates/routecodex-v3-runtime/tests/responses_relay_local_continuation_integration.rs',
    marker: 'json_stopless_center_natural_stop_guard_passes_cleaned_original_response',
    mutation: 'json_stopless_budget_tool_call_semantic_test_removed',
    diagnostic: /json_stopless_center_natural_stop_guard_passes_cleaned_original_response/,
  },
  {
    name: 'apply_patch SSE rejects requires_action terminal assertion removed',
    file: 'v3/crates/routecodex-v3-runtime/tests/responses_relay_local_continuation_integration.rs',
    marker: 'Responses Relay client SSE must not use response.requires_action as the terminal stream event',
    mutation: 'apply_patch SSE terminal assertion removed',
    diagnostic: /response\.requires_action as the terminal stream event/,
  },
  {
    name: 'Codex additional_tools original JSON path assertion removed',
    file: 'v3/crates/routecodex-v3-runtime/tests/responses_relay_local_continuation_integration.rs',
    marker: 'no-original-tools request must not synthesize Responses input.additional_tools',
    mutation: 'request path check removed',
    diagnostic: /no-original-tools request must not synthesize Responses input\.additional_tools/,
  },
  {
    name: 'stopless additional_tools lift helper revived',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/servertool_hooks.rs',
    marker: 'use super::{',
    mutation: 'fn lift_additional_tools_into_provider_tool_surface() {}\nuse super::{',
    diagnostic: /tool declaration shape rebuild helper|lift_additional_tools_into_provider_tool_surface/,
  },
  {
    name: 'Responses HTTP additional_tools transport lift revived',
    file: 'v3/crates/routecodex-v3-provider-responses/src/transport.rs',
    marker: 'pub struct V3Transport13ResponsesRequest',
    mutation: 'fn responses_http_provider_request_lifts_additional_tools_to_protocol_tools() {}\npub struct V3Transport13ResponsesRequest',
    diagnostic: /Responses HTTP additional_tools global lift|responses_http_provider_request_lifts_additional_tools_to_protocol_tools/,
  },
  {
    name: 'provider transport Anthropic protocol conversion revived',
    file: 'v3/crates/routecodex-v3-provider-responses/src/transport.rs',
    marker: 'pub fn build_v3_transport_13_responses_request_from_v3_provider_12(',
    mutation:
      'fn build_anthropic_messages_body() {}\npub fn build_v3_transport_13_responses_request_from_v3_provider_12(',
    diagnostic: /provider transport protocol conversion outside Chat Process|build_anthropic_messages_body/,
  },
  {
    name: 'mainline edge owner drift',
    file: 'docs/architecture/manifests/v3.hub_relay.tool_servertool_multiturn_parity.mainline.yml',
    marker: 'owner_feature_id: v3.relay_tool_servertool_multiturn_parity_closeout',
    mutation: 'owner_feature_id: v3.hub_relay_runtime_closeout',
    diagnostic: /owner_feature_id mismatch|edge v3-relay-tool-parity/,
  },
  {
    name: 'package script removed',
    file: 'package.json',
    marker: '    "verify:v3-relay-tool-servertool-multiturn-parity-closeout": "node scripts/architecture/verify-v3-relay-tool-servertool-multiturn-parity.mjs",\n',
    mutation: '',
    diagnostic: /missing script verify:v3-relay-tool-servertool-multiturn-parity-closeout/,
  },
  {
    name: 'full materialization shortcut appears',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/relay_request.rs',
    marker: 'fn govern_tool_outputs_at_req04',
    mutation: 'fn full_materialize_govern_tool_outputs_at_req04',
    diagnostic: /full payload materialization shortcut|full_materialize/,
  },
  {
    name: 'legal metadata_center method reference with nearby payload write',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/relay_request.rs',
    marker: 'fn govern_tool_outputs_at_req04',
    mutation:
      'fn metadata_center_leak() { let mut payload = serde_json::Map::new(); payload.insert("metadata_center".to_string(), true.into()); }\nfn govern_tool_outputs_at_req04',
    diagnostic: /MetadataCenter payload\/control leakage/,
  },
  {
    name: 'metadata_center method-name string literal written into payload',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/relay_request.rs',
    marker: 'fn govern_tool_outputs_at_req04',
    mutation:
      'fn metadata_center_string_leak() { let mut payload = serde_json::Map::new(); payload.insert("is_metadata_center_local_search".to_string(), true.into()); }\nfn govern_tool_outputs_at_req04',
    diagnostic: /MetadataCenter payload\/control leakage/,
  },
];

const failures = [];
for (const testCase of cases) {
  const root = mkdtempSync(join(tmpdir(), 'v3-relay-tool-parity-red-'));
  try {
    for (const relative of copyPaths) {
      const destination = resolve(root, relative);
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(resolve(repo, relative), destination, { recursive: true });
    }
    const target = resolve(root, testCase.file);
    const source = readFileSync(target, 'utf8');
    if (!source.includes(testCase.marker)) {
      failures.push(`${testCase.name}: mutation marker missing`);
      continue;
    }
    writeFileSync(
      target,
      testCase.all
        ? source.split(testCase.marker).join(testCase.mutation)
        : source.replace(testCase.marker, testCase.mutation),
    );
    const result = spawnSync(process.execPath, [verifier], { cwd: root, encoding: 'utf8' });
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    if (result.status === 0) failures.push(`${testCase.name}: verifier unexpectedly passed`);
    else if (!testCase.diagnostic.test(output)) {
      failures.push(`${testCase.name}: wrong diagnostic: ${output.slice(-900)}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (failures.length) {
  console.error('[test:v3-relay-tool-servertool-multiturn-parity-closeout-red-fixtures] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(`[test:v3-relay-tool-servertool-multiturn-parity-closeout-red-fixtures] ok (${cases.length} forbidden mutations rejected)`);
