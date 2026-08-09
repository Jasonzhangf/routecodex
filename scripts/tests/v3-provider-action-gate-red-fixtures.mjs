#!/usr/bin/env node
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

const repo = process.cwd();
const verifier = resolve(repo, 'scripts/architecture/verify-v3-provider-action-gate.mjs');
const copied = [
  'package.json',
  '.github/workflows/test.yml',
  'v3/crates/routecodex-v3-error/src/lib.rs',
  'v3/crates/routecodex-v3-error/tests/typed_error05_terminal_contract.rs',
  'v3/crates/routecodex-v3-runtime/src/provider_action_gate.rs',
  'v3/crates/routecodex-v3-runtime/src/provider_failure_runtime_policy.rs',
  'v3/crates/routecodex-v3-runtime/src/provider_failure_runtime_policy/tests.rs',
  'v3/crates/routecodex-v3-runtime/src/kernel.rs',
  'v3/crates/routecodex-v3-runtime/src/kernel/direct_runtime_helpers.rs',
  'v3/crates/routecodex-v3-runtime/src/kernel/direct_sse_provider_outcome.rs',
  'v3/crates/routecodex-v3-runtime/src/kernel/tests.rs',
  'v3/crates/routecodex-v3-runtime/src/kernel/tests/exact_pin.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime/provider_stream_materialization.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime/responses_provider_event_codec.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/openai_chat_relay_runtime.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/gemini_relay_runtime.rs',
  'v3/crates/routecodex-v3-runtime/tests/provider_action_gate_contract.rs',
  'v3/crates/routecodex-v3-runtime/tests/openai_chat_relay_runtime_integration.rs',
  'v3/crates/routecodex-v3-runtime/tests/gemini_relay_runtime_integration.rs',
  'v3/crates/routecodex-v3-runtime/tests/responses_direct_remote_continuation_integration.rs',
  'v3/crates/routecodex-v3-runtime/tests/hub_relay_runtime_closeout.rs',
  'v3/crates/routecodex-v3-runtime/tests/responses_direct_tool_passthrough.rs',
  'v3/crates/routecodex-v3-server/src/lib.rs',
  'v3/crates/routecodex-v3-server/src/tests/mod.rs',
  'docs/architecture/function-map.yml',
  'docs/architecture/resource-operation-map.yml',
  'docs/architecture/mainline-call-map.yml',
  'docs/architecture/verification-map.yml',
  'docs/architecture/v3-function-map.yml',
  'docs/architecture/v3-resource-operation-map.yml',
  'docs/architecture/v3-mainline-call-map.yml',
  'docs/architecture/v3-verification-map.yml',
  'docs/architecture/manifests/v3.provider_action_gate.mainline.yml',
  'docs/architecture/wiki/v3-provider-action-gate.md',
  'docs/goals/direct-relay-cross-request-error-storm-control-plan.md',
];

function mutateYaml(source, mutate) {
  const document = YAML.parse(source);
  mutate(document);
  return YAML.stringify(document);
}

function chain(document, chainId) {
  return document.chains.find((item) => item.chain_id === chainId);
}

function edge(document, stepId) {
  return document.chains.flatMap((item) => item.edges ?? []).find((item) => item.step_id === stepId);
}

function removeEdge(document, chainId, stepId) {
  const owner = chain(document, chainId);
  owner.edges = owner.edges.filter((item) => item.step_id !== stepId);
}
const cases = [
  {
    name: 'isolated floor shrinks',
    path: 'v3/crates/routecodex-v3-runtime/src/provider_action_gate.rs',
    mutate: (source) => source.replace('V3_PROVIDER_ACTION_ISOLATED_DELAY_MS: u64 = 1_000', 'V3_PROVIDER_ACTION_ISOLATED_DELAY_MS: u64 = 100'),
    diagnostic: /missing pub const V3_PROVIDER_ACTION_ISOLATED_DELAY_MS/u,
  },
  {
    name: 'Relay revives request-local delay',
    path: 'v3/crates/routecodex-v3-runtime/src/provider_failure_runtime_policy.rs',
    mutate: (source) => source.replace('pub(crate) struct V3RelayProviderFailureRetryPolicy {', 'pub(crate) struct V3RelayProviderFailureRetryPolicy {\n    retry_delay_ms: u64,'),
    diagnostic: /forbidden legacy token retry_delay_ms/u,
  },
  {
    name: 'runtime recreates a request-local gate',
    path: 'v3/crates/routecodex-v3-runtime/src/provider_failure_runtime_policy.rs',
    mutate: (source) => source.replaceAll(
      'action_gate: V3ProviderActionGate::process_shared()',
      'action_gate: V3ProviderActionGate::default()',
    ),
    diagnostic: /missing action_gate: V3ProviderActionGate::process_shared\(\)/u,
  },
  {
    name: 'OpenAI post-commit SSE failure loses fresh-request isolation coverage',
    path: 'v3/crates/routecodex-v3-runtime/tests/openai_chat_relay_runtime_integration.rs',
    mutate: (source) => source.replace(
      'post_commit_sse_failure_records_failure_but_does_not_block_a_fresh_request',
      'post_commit_sse_failure_has_no_fresh_request_isolation_contract',
    ),
    diagnostic: /missing active Rust test post_commit_sse_failure_records_failure_but_does_not_block_a_fresh_request/u,
  },
  {
    name: 'Gemini fresh request starts consuming an unrelated recovery lane',
    path: 'v3/crates/routecodex-v3-runtime/tests/gemini_relay_runtime_integration.rs',
    mutate: (source) => source.replace(
      'terminal_sse_recovery_does_not_block_a_fresh_request',
      'terminal_sse_recovery_blocks_a_fresh_request',
    ),
    diagnostic: /missing active Rust test terminal_sse_recovery_does_not_block_a_fresh_request/u,
  },
  {
    name: 'OpenAI active recovery loses explicit permit duration coverage',
    path: 'v3/crates/routecodex-v3-runtime/tests/openai_chat_relay_runtime_integration.rs',
    mutate: (source) => source.replace(
      'active_recovery_sse_blocks_a_second_recovery_beyond_five_seconds',
      'active_recovery_sse_has_no_explicit_permit_duration_contract',
    ),
    diagnostic: /missing active Rust test active_recovery_sse_blocks_a_second_recovery_beyond_five_seconds/u,
  },
  {
    name: 'Direct response.failed loses fresh-request isolation coverage',
    path: 'v3/crates/routecodex-v3-runtime/tests/responses_direct_remote_continuation_integration.rs',
    mutate: (source) => source.replace(
      'direct_post_commit_response_failed_records_failure_but_fresh_request_bypasses_recovery',
      'direct_post_commit_response_failed_has_no_fresh_request_isolation_contract',
    ),
    diagnostic: /missing active Rust test direct_post_commit_response_failed_records_failure_but_fresh_request_bypasses_recovery/u,
  },
  {
    name: 'Responses Relay terminal-missing loses fresh-request isolation coverage',
    path: 'v3/crates/routecodex-v3-runtime/tests/hub_relay_runtime_closeout.rs',
    mutate: (source) => source.replace(
      'responses_relay_terminal_missing_fails_explicitly_but_fresh_request_bypasses_recovery',
      'responses_relay_terminal_missing_has_no_fresh_request_isolation_contract',
    ),
    diagnostic: /missing active Rust test responses_relay_terminal_missing_fails_explicitly_but_fresh_request_bypasses_recovery/u,
  },
  {
    name: 'terminal transition is removed',
    path: 'v3/crates/routecodex-v3-runtime/src/provider_action_gate.rs',
    mutate: (source) => source.replace('pub fn commit_terminal_admission(', 'pub fn bypass_terminal_transition('),
    diagnostic: /missing pub fn commit_terminal_admission\(/u,
  },
  {
    name: 'terminal Error06 projection bypasses the failure gate',
    path: 'v3/crates/routecodex-v3-runtime/src/provider_action_gate.rs',
    mutate: (source) => source.replace(
      'record_failure_and_wait_for_terminal_projection',
      'project_terminal_without_wait',
    ),
    diagnostic: /missing record_failure_and_wait_for_terminal_projection/u,
  },
  {
    name: 'V3 admitted action permit loses explicit drop ownership',
    path: 'v3/crates/routecodex-v3-runtime/src/provider_action_gate.rs',
    mutate: (source) => source.replace(
      'impl Drop for V3ProviderActionPermit',
      'impl V3ProviderActionPermit',
    ),
    diagnostic: /missing impl Drop for V3ProviderActionPermit/u,
  },
  {
    name: 'V3 waiter ignores an already-owned group permit',
    path: 'v3/crates/routecodex-v3-runtime/src/provider_action_gate.rs',
    mutate: (source) => source.replace(
      '(!self.admit_action || !group_has_active_admission)',
      '(!self.admit_action || true)',
    ),
    diagnostic: /missing \(!self\.admit_action \|\| !group_has_active_admission\)/u,
  },
  {
    name: 'V3 success release drops the retained recovery ticket',
    path: 'v3/crates/routecodex-v3-runtime/src/provider_action_gate.rs',
    mutate: (source) => source.replace(
      'ReleasedBySuccess(V3ProviderActionRecoveryTicket),',
      'ReleasedBySuccess,',
    ),
    diagnostic: /success-released recovery transition must carry the exact retained recovery ticket/u,
  },
  {
    name: 'Responses Relay success release bypasses the retained recovery generation',
    path: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs',
    mutate: (source) => source.replace(
      'V3ProviderActionRecoveryTransition::ReleasedBySuccess(ticket) => {',
      'V3ProviderActionRecoveryTransition::ReleasedBySuccess(_ticket) => {',
    ),
    diagnostic: /Responses Relay must re-arm the exact retained recovery ticket/u,
  },
  {
    name: 'V3 unrelated failure revokes an already-owned group permit',
    path: 'v3/crates/routecodex-v3-runtime/src/provider_action_gate.rs',
    mutate: (source) => source.replace(
      'if !active_admission_owned {',
      'if true {',
    ),
    diagnostic: /missing if !active_admission_owned \{/u,
  },
  {
    name: 'V3 unrelated same-group provider success releases another provider permit',
    path: 'v3/crates/routecodex-v3-runtime/src/provider_action_gate.rs',
    mutate: (source) => source.replace(
      'key.provider_scope == *provider_scope\n                        || state.admitted_action_scope.as_ref() == Some(provider_scope)',
      'key.provider_scope.server_id == provider_scope.server_id\n                        && key.provider_scope.routing_group == provider_scope.routing_group',
    ),
    diagnostic: /provider success may release only its exact provider scope or the permit-owned action scope/u,
  },
  {
    name: 'Direct fresh requests enter the recovery gate by default',
    path: 'v3/crates/routecodex-v3-runtime/src/kernel.rs',
    mutate: (source) => source.replace(
      'let mut pending_provider_action_recovery = None;',
      'let mut pending_provider_action_gate = true;',
    ),
    diagnostic: /must not retain bool-only provider action recovery state/u,
  },
  {
    name: 'Direct pinned continuation ignores its active recovery lane',
    path: 'v3/crates/routecodex-v3-runtime/src/kernel.rs',
    mutate: (source) => source.replace(
      'wait_for_exact_selected_provider_action',
      'bypass_exact_selected_provider_action',
    ),
    diagnostic: /missing wait_for_exact_selected_provider_action/u,
  },
  {
    name: 'provider change restarts isolated delay',
    path: 'v3/crates/routecodex-v3-runtime/src/provider_action_gate.rs',
    mutate: (source) => source.replaceAll('active_lane_generation', 'bypassed_lane_generation'),
    diagnostic: /missing active_lane_generation/u,
  },
  {
    name: 'Direct mutates health before client disconnect classification',
    path: 'v3/crates/routecodex-v3-runtime/src/kernel/direct_runtime_helpers.rs',
    mutate: (source) => source.replace(
      'if matches!(source.source_kind, V3ErrorSourceKind::ClientDisconnect)',
      'if false && matches!(source.source_kind, V3ErrorSourceKind::ClientDisconnect)',
    ),
    diagnostic: /missing if matches!\(source.source_kind, V3ErrorSourceKind::ClientDisconnect\)/u,
  },
  {
    name: 'Direct exact-pin lookup failure returns to generic RuntimeFailure',
    path: 'v3/crates/routecodex-v3-runtime/src/kernel/tests/exact_pin.rs',
    mutate: (source) => source.replace(
      'missing_exact_pin_is_provider_availability_error05_without_router_reentry',
      'missing_exact_pin_returns_generic_runtime_failure',
    ),
    diagnostic: /missing missing_exact_pin_is_provider_availability_error05_without_router_reentry/u,
  },
  {
    name: 'server post-commit SSE closeout fabricates Error06 again',
    path: 'v3/crates/routecodex-v3-server/src/lib.rs',
    mutate: (source) => source.replaceAll(
      'emit_v3_post_commit_sse_source_console_line_for_context',
      'emit_v3_error_console_line_for_context',
    ),
    diagnostic: /missing emit_v3_post_commit_sse_source_console_line_for_context/u,
  },
  {
    name: 'Error06 accepts raw Error05',
    path: 'v3/crates/routecodex-v3-error/src/lib.rs',
    mutate: (source) => source.replace('terminal: V3Error05TerminalDecision', 'terminal: V3Error05ExecutionDecision'),
    diagnostic: /Error06 builder must accept only V3Error05TerminalDecision/u,
  },
  {
    name: 'V3 required atomic terminal commit edge is deleted',
    path: 'docs/architecture/v3-mainline-call-map.yml',
    mutate: (source) => mutateYaml(source, (document) => removeEdge(
      document,
      'v3.provider_action_gate.mainline',
      'v3-provider-action-gate-06',
    )),
    diagnostic: /missing required edge v3-provider-action-gate-06/u,
  },
  {
    name: 'V3 required provider success outcome edge is deleted',
    path: 'docs/architecture/v3-mainline-call-map.yml',
    mutate: (source) => mutateYaml(source, (document) => removeEdge(
      document,
      'v3.provider_action_gate.mainline',
      'v3-provider-action-gate-34',
    )),
    diagnostic: /missing required edge v3-provider-action-gate-34/u,
  },
  {
    name: 'V3 map declares a fake caller symbol',
    path: 'docs/architecture/v3-mainline-call-map.yml',
    mutate: (source) => mutateYaml(source, (document) => {
      edge(document, 'v3-provider-action-gate-01').caller_symbol = 'fake_execute_v3_responses_relay_runtime_inner';
    }),
    diagnostic: /caller_symbol must equal execute_v3_responses_relay_runtime_inner/u,
  },
  {
    name: 'V3 terminal admission caller stops invoking atomic commit',
    path: 'v3/crates/routecodex-v3-runtime/src/provider_action_gate.rs',
    mutate: (source) => source.replace(
      'if self.commit_terminal_admission(&key, &admission)?',
      'if self.bypass_terminal_admission_commit(&key, &admission)?',
    ),
    diagnostic: /does not call V3ProviderActionGate::commit_terminal_admission/u,
  },
  {
    name: 'V3 terminal admission leaves only a commented atomic commit',
    path: 'v3/crates/routecodex-v3-runtime/src/provider_action_gate.rs',
    mutate: (source) => source.replace(
      'if self.commit_terminal_admission(&key, &admission)?',
      'if self.bypass_terminal_admission_commit(&key, &admission)? { /* self.commit_terminal_admission(&key, &admission)? */ return Ok(admission); } else if false',
    ),
    diagnostic: /does not call V3ProviderActionGate::commit_terminal_admission/u,
  },
  {
    name: 'V3 terminal admission shadows the atomic commit symbol',
    path: 'v3/crates/routecodex-v3-runtime/src/provider_action_gate.rs',
    mutate: (source) => source.replace(
      'if self.commit_terminal_admission(&key, &admission)?',
      'let commit_terminal_admission = || true;\n            if commit_terminal_admission()',
    ),
    diagnostic: /shadows declared callee V3ProviderActionGate::commit_terminal_admission/u,
  },
  {
    name: 'V3 terminal admission calls the right method name on the wrong receiver',
    path: 'v3/crates/routecodex-v3-runtime/src/provider_action_gate.rs',
    mutate: (source) => source
      .replace(
        'impl V3ProviderActionGate {\n',
        'struct UnrelatedGate;\nimpl UnrelatedGate {\n    fn commit_terminal_admission(&self, _key: &V3ProviderActionGateKey, _admission: &V3ProviderActionAdmission) -> Result<bool, String> { Ok(true) }\n}\n\nimpl V3ProviderActionGate {\n',
      )
      .replace(
        'if self.commit_terminal_admission(&key, &admission)?',
        'if UnrelatedGate.commit_terminal_admission(&key, &admission)?',
      ),
    diagnostic: /does not call V3ProviderActionGate::commit_terminal_admission/u,
  },
  {
    name: 'V3 manifest endpoint drifts from map',
    path: 'docs/architecture/manifests/v3.provider_action_gate.mainline.yml',
    mutate: (source) => source.replace(
      '    to: V3ProviderActionGateTerminalCommitted\n',
      '    to: V3ProviderActionGateTerminalBypassed\n',
    ),
    diagnostic: /endpoints are out of sync/u,
  },
  {
    name: 'V3 manifest drops provider action gate resource binding',
    path: 'docs/architecture/manifests/v3.provider_action_gate.mainline.yml',
    mutate: (source) => source.replace('  - v3.error.provider_action_gate\n', ''),
    diagnostic: /resources: missing binding v3\.error\.provider_action_gate/u,
  },
  {
    name: 'V3 manifest revives wall-clock admission expiry',
    path: 'docs/architecture/manifests/v3.provider_action_gate.mainline.yml',
    mutate: (source) => source.replace(
      '  wall_clock_expiry: forbidden\n',
      '  wall_clock_expiry: after_5000ms\n',
    ),
    diagnostic: /admission_permit must lock explicit ownership/u,
  },
  {
    name: 'V3 manifest moves typed Error05 to the Server owner',
    path: 'docs/architecture/manifests/v3.provider_action_gate.mainline.yml',
    mutate: (source) => source.replace(
      '  - node_id: V3Error05ExecutionDecision\n    owner: routecodex-v3-error\n',
      '  - node_id: V3Error05ExecutionDecision\n    owner: routecodex-v3-server\n',
    ),
    diagnostic: /V3Error05ExecutionDecision owner must be routecodex-v3-error/u,
  },
  {
    name: 'V3 resource map drops atomic terminal writer',
    path: 'docs/architecture/v3-resource-operation-map.yml',
    mutate: (source) => mutateYaml(source, (document) => {
      const resource = document.resources.find((item) => item.resource_id === 'v3.error.provider_action_gate');
      resource.allowed_writers = resource.allowed_writers.filter(
        (writer) => writer !== 'V3ProviderActionGate::commit_terminal_admission',
      );
    }),
    diagnostic: /allowed_writers: missing binding V3ProviderActionGate::commit_terminal_admission/u,
  },
  {
    name: 'V3 resource lifecycle drifts from its chain',
    path: 'docs/architecture/v3-resource-operation-map.yml',
    mutate: (source) => source.replace(
      '    lifecycle: v3.provider_action_gate.mainline\n',
      '    lifecycle: fake.v3.provider_action_gate.lifecycle\n',
    ),
    diagnostic: /V3 lifecycle\/chain\/owner binding drift/u,
  },
  {
    name: 'V3 resource owner drifts from the Runtime gate',
    path: 'docs/architecture/v3-resource-operation-map.yml',
    mutate: (source) => source.replace(
      '  - resource_id: v3.error.provider_action_gate\n    resource_kind: process_local_control_side_channel\n    lifecycle: v3.provider_action_gate.mainline\n    owner_crate: routecodex-v3-runtime\n',
      '  - resource_id: v3.error.provider_action_gate\n    resource_kind: process_local_control_side_channel\n    lifecycle: v3.provider_action_gate.mainline\n    owner_crate: routecodex-v3-server\n',
    ),
    diagnostic: /V3 lifecycle\/chain\/owner binding drift/u,
  },
  {
    name: 'V3 wiki fabricates a terminal commit downstream edge',
    path: 'docs/architecture/wiki/v3-provider-action-gate.md',
    mutate: (source) => source.replace(
      '  TerminalAdmission -->|v3-provider-action-gate-06| TerminalCommit\n',
      '  TerminalAdmission -->|v3-provider-action-gate-06| TerminalCommit\n  TerminalCommit -->|fabricated gate witness| E05\n',
    ),
    diagnostic: /terminal commit cannot claim a downstream machine edge/u,
  },
  {
    name: 'V3 wiki changes the compat failure edge endpoint',
    path: 'docs/architecture/wiki/v3-provider-action-gate.md',
    mutate: (source) => source.replace(
      '  Compat -->|v3-provider-action-gate-01| E05\n',
      '  Compat -->|v3-provider-action-gate-01| TerminalCommit\n',
    ),
    diagnostic: /v3-provider-action-gate-01 must be Compat -> E05/u,
  },
  {
    name: 'V3 wiki keeps a required edge only in an HTML comment',
    path: 'docs/architecture/wiki/v3-provider-action-gate.md',
    mutate: (source) => source
      .replace('  Compat -->|v3-provider-action-gate-01| E05\n', '')
      .replace(
        '```\n\nThe gate',
        '```\n\n<!-- Compat -->|v3-provider-action-gate-01| E05 -->\n\nThe gate',
      ),
    diagnostic: /machine edge IDs: missing binding v3-provider-action-gate-01/u,
  },
  {
    name: 'V3 map duplicates a required edge ID',
    path: 'docs/architecture/v3-mainline-call-map.yml',
    mutate: (source) => mutateYaml(source, (document) => {
      const owner = chain(document, 'v3.provider_action_gate.mainline');
      owner.edges.push(structuredClone(edge(document, 'v3-provider-action-gate-06')));
    }),
    diagnostic: /duplicate edge IDs: v3-provider-action-gate-06/u,
  },
  {
    name: 'Responses Relay target projection error bypasses request-local fail-fast',
    path: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs',
    mutate: (source) => source.replace(
      'let req_compat = match build_provider_req_compat_06_from_v3_hub_req_outbound_07(req07) {\n            Ok(req_compat) => req_compat,\n            Err(error) => {\n                handle_provider_request_failure!(V3ResponsesRelayRuntimeError::ProviderCompat(\n                    error\n                ));\n            }\n        };',
      'let req_compat = build_provider_req_compat_06_from_v3_hub_req_outbound_07(req07).unwrap();',
    ),
    diagnostic: /ProviderReqCompat06ProviderCompat request-local fail-fast branch is missing/u,
  },
  {
    name: 'Responses Relay wire encoding failure bypasses typed provider failure handling',
    path: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs',
    mutate: (source) => source.replace(
      'handle_provider_request_failure!(V3ResponsesRelayRuntimeError::Provider(error));',
      'bypass_provider_request_failure!(V3ResponsesRelayRuntimeError::Provider(error));',
    ),
    diagnostic: /V3ProviderReqOutbound08WirePayload failure branch must enter handle_provider_request_failure/u,
  },
  {
    name: 'Responses Relay accepts response.done as provider semantic terminal',
    path: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs',
    mutate: (source) => source.replace(
      'Some("response.completed") => Some("completed".to_string()),',
      'Some("response.completed" | "response.done") => Some("completed".to_string()),',
    ),
    diagnostic: /provider response\.done\/response\.requires_action must not satisfy the response\.completed terminal contract/u,
  },
  {
    name: 'Responses Relay event codec accepts response.done as provider semantic terminal',
    path: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime/responses_provider_event_codec.rs',
    mutate: (source) => source.replace(
      'Some("response.completed") => {',
      'Some("response.completed" | "response.done") => {',
    ),
    diagnostic: /provider response\.done\/response\.requires_action must not satisfy the response\.completed terminal contract/u,
  },
  {
    name: 'Direct provider outcome accepts response.done as provider semantic terminal',
    path: 'v3/crates/routecodex-v3-runtime/src/kernel/direct_sse_provider_outcome.rs',
    mutate: (source) => source.replace(
      'if event_type == "response.completed" {',
      'if matches!(event_type, "response.completed" | "response.done") {',
    ),
    diagnostic: /provider response\.done must not satisfy the response\.completed terminal contract/u,
  },
  {
    name: 'Relay target-resolution source errors are swallowed as exhaustion',
    path: 'v3/crates/routecodex-v3-runtime/src/provider_failure_runtime_policy.rs',
    mutate: (source) => source.replace(
      'let resolution = reselect_from_captured_target_plan(',
      'let resolution = if let Ok(alternative) = resolve_v3_relay_target(',
    ),
    diagnostic: /target-resolution source errors must not be swallowed as provider-pool exhaustion/u,
  },
  {
    name: 'Recovery ticket exact-key wait is removed',
    path: 'v3/crates/routecodex-v3-runtime/src/provider_action_gate.rs',
    mutate: (source) => source.replaceAll('wait_for_recovery_ticket', 'wait_for_latest_group_lane'),
    diagnostic: /missing wait_for_recovery_ticket/u,
  },
  {
    name: 'Error05 recovery witness generation is deleted',
    path: 'v3/crates/routecodex-v3-error/src/lib.rs',
    mutate: (source) => source.replace(
      /(pub struct V3Error05RecoveryAdmissionWitness\s*\{[^}]*?)\s+generation:\s*u64,\n/u,
      '$1\n',
    ),
    diagnostic: /V3Error05RecoveryAdmissionWitness missing generation: u64/u,
  },
  {
    name: 'Required Responses provider raw-to-codec edge is deleted',
    path: 'docs/architecture/v3-mainline-call-map.yml',
    mutate: (source) => mutateYaml(source, (document) => removeEdge(
      document,
      'v3.provider_action_gate.mainline',
      'v3-provider-action-gate-50',
    )),
    diagnostic: /missing required edge v3-provider-action-gate-50/u,
  },
  {
    name: 'Responses Relay failure handler returns before shared provider failure policy',
    path: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs',
    mutate: (source) => source.replace(
      '    let result = run_v3_relay_provider_failure_policy(\n',
      '    if failure.terminal_projection.is_none() {\n        return Ok(Some(failure));\n    }\n    let result = run_v3_relay_provider_failure_policy(\n',
    ),
    diagnostic: /must enter run_v3_relay_provider_failure_policy immediately after its existing terminal projection guard/u,
  },
  {
    name: 'Required gate test name survives only in a comment',
    path: 'v3/crates/routecodex-v3-runtime/tests/provider_action_gate_contract.rs',
    mutate: (source) => source.replace(
      '#[tokio::test]\nasync fn isolated_failure_blocks_one_action_for_at_least_one_second()',
      '// isolated_failure_blocks_one_action_for_at_least_one_second\nasync fn disabled_isolated_failure_test()',
    ),
    diagnostic: /missing active Rust test isolated_failure_blocks_one_action_for_at_least_one_second/u,
  },
  {
    name: 'CI drops red fixtures',
    path: '.github/workflows/test.yml',
    mutate: (source) => source.replaceAll('npm run test:v3-provider-action-gate-red-fixtures', 'echo provider-action-red-fixtures-skipped'),
    diagnostic: /missing npm run test:v3-provider-action-gate-red-fixtures/u,
  },
];

const failures = [];
const baseline = spawnSync(process.execPath, [verifier], { cwd: repo, encoding: 'utf8' });
if (baseline.status !== 0) {
  const output = `${baseline.stdout || ''}\n${baseline.stderr || ''}`.trim();
  console.error('[test:v3-provider-action-gate-red-fixtures] failed');
  console.error('- baseline verifier must pass before mutation fixtures run');
  if (output) console.error(output);
  process.exit(1);
}

for (const testCase of cases) {
  const root = mkdtempSync(join(tmpdir(), 'v3-provider-action-gate-red-'));
  try {
    for (const rel of copied) {
      const target = resolve(root, rel);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(resolve(repo, rel), target, { recursive: true });
    }
    const target = resolve(root, testCase.path);
    const original = readFileSync(target, 'utf8');
    const mutated = testCase.mutate(original);
    if (mutated === original) {
      failures.push(`${testCase.name}: mutation did not change ${testCase.path}`);
      continue;
    }
    writeFileSync(target, mutated);
    const result = spawnSync(process.execPath, [verifier], { cwd: root, encoding: 'utf8' });
    const output = `${result.stdout || ''}\n${result.stderr || ''}`;
    if (result.status === 0) failures.push(`${testCase.name}: verifier unexpectedly passed`);
    else if (!testCase.diagnostic.test(output)) failures.push(`${testCase.name}: wrong diagnostic: ${output.slice(-1200)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
if (failures.length) {
  console.error('[test:v3-provider-action-gate-red-fixtures] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(`[test:v3-provider-action-gate-red-fixtures] ok (${cases.length} forbidden mutations rejected)`);
