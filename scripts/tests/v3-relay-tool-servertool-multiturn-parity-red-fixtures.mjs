#!/usr/bin/env node
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = process.cwd();
const verifier = resolve(repo, 'scripts/architecture/verify-v3-relay-tool-servertool-multiturn-parity.mjs');
const copyPaths = [
  'v3/crates/routecodex-v3-runtime/src/hub_v1.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/relay_request.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/servertool_hooks.rs',
  'v3/crates/routecodex-v3-provider-responses/src/transport.rs',
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
    name: 'orphan tool output fail-fast removed',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/relay_request.rs',
    marker: 'OrphanToolOutput { index: usize, call_id: String }',
    mutation: 'MissingOrphanOutput { index: usize, call_id: String }',
    diagnostic: /OrphanToolOutput/,
  },
  {
    name: 'attachment history policy removed',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/relay_request.rs',
    marker: 'pub enum V3HubAttachmentHistoryPolicy',
    mutation: 'pub enum V3HubAttachmentPolicyRemoved',
    diagnostic: /V3HubAttachmentHistoryPolicy/,
  },
  {
    name: 'attachment history governance moved before Req04',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/relay_request.rs',
    marker: '        let mut events = vec![\n',
    mutation:
      '        govern_attachment_history_at_req04(&mut serde_json::Value::Null, &attachment_history_policy)?;\n        let mut events = vec![\n',
    diagnostic: /attachment history governance before Req04/,
  },
  {
    name: 'tool kind classifier removed',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1.rs',
    marker: 'pub(crate) fn classify_v3_hub_relay_tool_kind',
    mutation: 'pub(crate) fn classify_tool_kind_removed',
    diagnostic: /classify_v3_hub_relay_tool_kind/,
  },
  {
    name: 'apply_patch response freeform projection removed',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1.rs',
    marker: 'fn project_v3_apply_patch_freeform_calls_at_resp03',
    mutation: 'project_v3_apply_patch_projection_removed',
    diagnostic: /project_v3_apply_patch_freeform_calls_at_resp03/,
  },
  {
    name: 'Resp04 non-terminal tool-call canonicalization removed',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1.rs',
    marker: 'fn canonicalize_v3_hub_resp04_finalized_payload',
    mutation: 'fn resp04_tool_call_payload_projection_removed',
    diagnostic: /canonicalize_v3_hub_resp04_finalized_payload/,
  },
  {
    name: 'SSE requires_action transport event relabeled as completed',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs',
    marker: 'Some("requires_action") => "response.requires_action"',
    mutation: 'Some("requires_action") => "response.completed"',
    diagnostic: /response\.requires_action/,
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
    marker: 'assert_original_tools_preserved(&captures[1], second_tools.as_array().unwrap());',
    mutation: '',
    diagnostic: /assert_original_tools_preserved/,
  },
  {
    name: 'Codex additional_tools shape blackbox removed',
    file: 'v3/crates/routecodex-v3-runtime/tests/responses_relay_local_continuation_integration.rs',
    marker: 'json_stopless_preserves_codex_additional_tools_across_continuation',
    mutation: 'json_stopless_additional_tools_shape_test_removed',
    diagnostic: /json_stopless_preserves_codex_additional_tools_across_continuation/,
  },
  {
    name: 'budget-exhausted provider tool-call client semantic blackbox removed',
    file: 'v3/crates/routecodex-v3-runtime/tests/responses_relay_local_continuation_integration.rs',
    marker: 'json_stopless_budget_exhausted_provider_tool_call_returns_requires_action',
    mutation: 'json_stopless_budget_tool_call_semantic_test_removed',
    diagnostic: /json_stopless_budget_exhausted_provider_tool_call_returns_requires_action/,
  },
  {
    name: 'apply_patch SSE tool-call continuation no-relabel assertion removed',
    file: 'v3/crates/routecodex-v3-runtime/tests/responses_relay_local_continuation_integration.rs',
    marker: 'Responses Relay client SSE must not relabel Hub-finalized tool-call continuation as completed',
    mutation: 'apply_patch sse relabel assertion removed',
    diagnostic: /tool-call continuation/,
  },
  {
    name: 'Codex additional_tools original JSON path assertion removed',
    file: 'v3/crates/routecodex-v3-runtime/tests/responses_relay_local_continuation_integration.rs',
    marker: 'request path $.tools must be absent because the original request did not contain $.tools',
    mutation: 'request path check removed',
    diagnostic: /request path \$\.tools must be absent/,
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
    marker: 'responses_http_provider_request_preserves_additional_tools_surface',
    mutation: 'responses_http_provider_request_lifts_additional_tools_to_protocol_tools',
    diagnostic: /responses_http_provider_request_preserves_additional_tools_surface|Responses HTTP additional_tools global lift/,
  },
  {
    name: 'provider transport Anthropic protocol conversion revived',
    file: 'v3/crates/routecodex-v3-provider-responses/src/transport.rs',
    marker: 'pub fn build_v3_transport_13_responses_request_from_v3_provider_12(',
    mutation:
      'fn build_anthropic_messages_body() {}\npub fn build_v3_transport_13_responses_request_from_v3_provider_12(',
    diagnostic: /non-ChatProcess protocol conversion in provider transport|build_anthropic_messages_body/,
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
    diagnostic: /fallback\/materialization|full_materialize/,
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
    writeFileSync(target, source.replace(testCase.marker, testCase.mutation));
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
