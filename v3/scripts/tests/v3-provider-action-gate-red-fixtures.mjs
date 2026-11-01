#!/usr/bin/env node
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const v3Root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const verifier = resolve(v3Root, 'scripts/architecture/verify-v3-provider-action-gate.mjs');
const copied = [
  'v3/package.json',
  '.github/workflows/test.yml',
  'v3/crates/routecodex-v3-error/src/lib.rs',
  'v3/crates/routecodex-v3-error/tests/typed_error05_terminal_contract.rs',
  'v3/crates/routecodex-v3-runtime/src/provider_failure_runtime_policy.rs',
  'v3/crates/routecodex-v3-runtime/src/provider_probe_lifecycle.rs',
  'v3/crates/routecodex-v3-runtime/src/provider_health_observation.rs',
  'v3/crates/routecodex-v3-runtime/src/provider_failure_runtime_policy_health.rs',
  'v3/crates/routecodex-v3-runtime/src/provider_failure_runtime_policy_events.rs',
  'v3/crates/routecodex-v3-runtime/src/provider_cooldown_rescue.rs',
  'v3/crates/routecodex-v3-runtime/src/provider_failure_runtime_policy/tests.rs',
  'v3/crates/routecodex-v3-runtime/src/provider_failure_runtime_policy/provider_action_gate_tests.rs',
  'v3/crates/routecodex-v3-runtime/src/kernel.rs',
  'v3/crates/routecodex-v3-runtime/src/kernel/direct_runtime_helpers.rs',
  'v3/crates/routecodex-v3-runtime/src/kernel/direct_runtime_helpers_stream.rs',
  'v3/crates/routecodex-v3-runtime/src/kernel/direct_kernel_entrypoints.rs',
  'v3/crates/routecodex-v3-runtime/src/kernel/direct_protocol_plan.rs',
  'v3/crates/routecodex-v3-runtime/src/kernel/direct_response_thinking_compat.rs',
  'v3/crates/routecodex-v3-runtime/src/kernel/direct_response_thinking_compat_tests.rs',
  'v3/crates/routecodex-v3-runtime/src/kernel/direct_state.rs',
  'v3/crates/routecodex-v3-runtime/src/kernel/v3_direct_core.rs',
  'v3/crates/routecodex-v3-runtime/tests/support/kernel_unit.rs',
  'v3/crates/routecodex-v3-runtime/tests/support/openai_chat_relay_runtime_unit.rs',
  'v3/crates/routecodex-v3-runtime/src/sse_object_pipeline.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_sse_tree.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/provider_sse_json_codec.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/provider_responses_event_classification.rs',
  'v3/crates/routecodex-v3-runtime/src/kernel/tests.rs',
  'v3/crates/routecodex-v3-runtime/src/kernel/tests/exact_pin.rs',
  'v3/crates/routecodex-v3-runtime/src/kernel/tests/protocol_mode_lock.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime_inner.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/relay_runtime_shared.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/relay_runtime_core.rs',
  'v3/crates/routecodex-v3-server/src/console/impl_bulk.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime_tests_extra.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_failures.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime/provider_stream_materialization.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime/responses_provider_event_codec.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/openai_chat_relay_runtime.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/openai_chat_relay_runtime_sse.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime_helpers.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/gemini_relay_runtime.rs',
  'v3/crates/routecodex-v3-runtime/tests/openai_chat_relay_runtime_integration.rs',
  'v3/crates/routecodex-v3-runtime/tests/gemini_relay_runtime_integration.rs',
  'v3/crates/routecodex-v3-runtime/tests/hub_relay_runtime_closeout.rs',
  'v3/crates/routecodex-v3-runtime/tests/responses_direct_tool_passthrough.rs',
  'v3/crates/routecodex-v3-server/src/lib.rs',
  'v3/crates/routecodex-v3-server/src/tests/mod.rs',
  'v3/crates/routecodex-v3-server/tests/support/pool_empty_recovery_blackbox.rs',
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
    name: 'Direct provider action gate revives the removed handoff-budget executor',
    path: 'v3/crates/routecodex-v3-runtime/src/kernel.rs',
    mutate: (source) => source.replaceAll(
      'execute_v3_responses_direct_runtime_kernel_core_resident',
      'execute_v3_responses_direct_runtime_kernel_core_with_handoff_budget',
    ),
    diagnostic: /forbidden removed Direct lifecycle symbol execute_v3_responses_direct_runtime_kernel_core_with_handoff_budget/u,
  },
  {
    name: 'Direct provider action gate revives the removed SSE handoff wrapper',
    path: 'v3/crates/routecodex-v3-runtime/src/kernel/direct_runtime_helpers_stream.rs',
    mutate: (source) => source.replaceAll(
      'collect_direct_sse_attempt_after_terminal',
      'wrap_direct_sse_provider_handoff_stream',
    ),
    diagnostic: /forbidden removed Direct lifecycle symbol wrap_direct_sse_provider_handoff_stream/u,
  },
  {
    name: 'Relay revives request-local delay',
    path: 'v3/crates/routecodex-v3-runtime/src/provider_failure_runtime_policy.rs',
    mutate: (source) => source.replace('pub(crate) struct V3RelayProviderFailureRetryPolicy {', 'pub(crate) struct V3RelayProviderFailureRetryPolicy {\n    retry_delay_ms: u64,'),
    diagnostic: /forbidden legacy token retry_delay_ms/u,
  },
  {
    name: 'OpenAI post-commit SSE failure loses fresh-request isolation coverage',
    path: 'v3/crates/routecodex-v3-runtime/tests/openai_chat_relay_runtime_integration.rs',
    mutate: (source) => source.replace(
      'sse_provider_attempt_is_not_committed_before_provider_terminal',
      'sse_provider_attempt_has_no_terminal_commit_contract',
    ),
    diagnostic: /missing active Rust test sse_provider_attempt_is_not_committed_before_provider_terminal/u,
  },
  {
    name: 'Gemini fresh request starts consuming an unrelated recovery lane',
    path: 'v3/crates/routecodex-v3-runtime/tests/gemini_relay_runtime_integration.rs',
    mutate: (source) => source.replace(
      'validated_terminal_sse_releases_action_lane_for_a_fresh_request',
      'validated_terminal_sse_blocks_a_fresh_request',
    ),
    diagnostic: /missing active Rust test validated_terminal_sse_releases_action_lane_for_a_fresh_request/u,
  },
  {
    name: 'OpenAI active recovery loses explicit permit duration coverage',
    path: 'v3/crates/routecodex-v3-runtime/tests/openai_chat_relay_runtime_integration.rs',
    mutate: (source) => source.replace(
      'sse_provider_attempt_is_not_committed_before_provider_terminal',
      'sse_provider_attempt_has_no_terminal_commit_contract',
    ),
    diagnostic: /missing active Rust test sse_provider_attempt_is_not_committed_before_provider_terminal/u,
  },
  {
    name: 'Direct response.failed loses fresh-request isolation coverage',
    path: 'v3/crates/routecodex-v3-runtime/tests/responses_direct_tool_passthrough.rs',
    mutate: (source) => source.replace(
      'failed_terminal_sse_attempt_never_commits_partial_bytes_and_exhausts_to_error06',
      'failed_terminal_sse_attempt_has_no_error06_contract',
    ),
    diagnostic: /missing active Rust test failed_terminal_sse_attempt_never_commits_partial_bytes_and_exhausts_to_error06/u,
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
    name: 'Responses Relay content_filter terminal loses faithful-forward coverage',
    path: 'v3/crates/routecodex-v3-runtime/tests/hub_relay_runtime_closeout.rs',
    mutate: (source) => source.replace(
      'responses_relay_content_filter_incomplete_preserves_output_without_reselect',
      'responses_relay_incomplete_exhaustion_has_no_typed_terminal_contract',
    ),
    diagnostic: /missing active Rust test responses_relay_content_filter_incomplete_preserves_output_without_reselect/u,
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
    name: 'Direct previous_response_id rejection loses anti-revival coverage',
    path: 'v3/crates/routecodex-v3-runtime/src/kernel/tests/exact_pin.rs',
    mutate: (source) => source.replace(
      'previous_response_id_is_rejected_without_router_or_provider_reentry',
      'previous_response_id_has_no_retirement_contract',
    ),
    diagnostic: /missing previous_response_id_is_rejected_without_router_or_provider_reentry/u,
  },
  {
    name: 'server post-commit SSE closeout fabricates Error06 again',
    path: 'v3/crates/routecodex-v3-server/src/console/impl_bulk.rs',
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
    name: 'V3 required health observation edge is deleted',
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
    name: 'V3 manifest endpoint drifts from map',
    path: 'docs/architecture/manifests/v3.provider_action_gate.mainline.yml',
    mutate: (source) => source.replace(
      '    to: V3Error05ExecutionDecision\n',
      '    to: V3Error06ClientProjected\n',
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
    name: 'V3 manifest shortens the request-local error hold',
    path: 'docs/architecture/manifests/v3.provider_action_gate.mainline.yml',
    mutate: (source) => source.replace(
      '  hold_ms: 2000\n',
      '  hold_ms: 1000\n',
    ),
    diagnostic: /Error return must be request-local/u,
  },
  {
    name: 'V3 manifest permits a shared error-return admission lane',
    path: 'docs/architecture/manifests/v3.provider_action_gate.mainline.yml',
    mutate: (source) => source.replace(
      '  shared_admission: forbidden\n',
      '  shared_admission: allowed\n',
    ),
    diagnostic: /Error return must be request-local/u,
  },
  {
    name: 'V3 manifest claims whole-lifecycle SESE for the multi-terminal action lifecycle',
    path: 'docs/architecture/manifests/v3.provider_action_gate.mainline.yml',
    mutate: (source) => source.replace(
      '  sese_scope: per_flow_only_whole_lifecycle_multi_terminal\n',
      '  sese_scope: whole_lifecycle_sese\n',
    ),
    diagnostic: /must not be claimed as whole-lifecycle SESE/u,
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
    name: 'V3 resource map drops the request-local policy writer',
    path: 'docs/architecture/v3-resource-operation-map.yml',
    mutate: (source) => mutateYaml(source, (document) => {
      const resource = document.resources.find((item) => item.resource_id === 'v3.error.provider_action_gate');
      resource.allowed_writers = resource.allowed_writers.filter(
        (writer) => writer !== 'run_v3_relay_provider_failure_policy_with_response_source_inner',
      );
    }),
    diagnostic: /allowed_writers: missing binding run_v3_relay_provider_failure_policy_with_response_source_inner/u,
  },
  {
    name: 'V3 resource lifecycle drifts from its chain',
    path: 'docs/architecture/v3-resource-operation-map.yml',
    mutate: (source) => mutateYaml(source, (document) => {
      const resource = document.resources.find((item) => item.resource_id === 'v3.error.provider_action_gate');
      resource.lifecycle = 'fake.v3.provider_action_gate.lifecycle';
    }),
    diagnostic: /V3 lifecycle\/chain\/owner binding drift/u,
  },
  {
    name: 'V3 resource owner drifts from the Runtime gate',
    path: 'docs/architecture/v3-resource-operation-map.yml',
    mutate: (source) => mutateYaml(source, (document) => {
      const resource = document.resources.find((item) => item.resource_id === 'v3.error.provider_action_gate');
      resource.owner_crate = 'routecodex-v3-server';
    }),
    diagnostic: /V3 lifecycle\/chain\/owner binding drift/u,
  },
  {
    name: 'V3 wiki revives the retired provider action admission node',
    path: 'docs/architecture/wiki/v3-provider-action-gate.md',
    mutate: (source) => source.replace(
      '  ProviderOutcome[V3ProviderResponsesTerminalOrFailureObserved]\n',
      '  ProviderOutcome[V3ProviderResponsesTerminalOrFailureObserved]\n  Gate[V3ProviderActionGateAdmission]\n',
    ),
    diagnostic: /retired provider action admission nodes must not be declared/u,
  },
  {
    name: 'V3 wiki changes the compat failure edge endpoint',
    path: 'docs/architecture/wiki/v3-provider-action-gate.md',
    mutate: (source) => source.replace(
      '  Compat -->|v3-provider-action-gate-01| E05\n',
      '  Compat -->|v3-provider-action-gate-01| Health\n',
    ),
    diagnostic: /v3-provider-action-gate-01 must be Compat -> E05/u,
  },
  {
    name: 'V3 wiki keeps a required edge only in an HTML comment',
    path: 'docs/architecture/wiki/v3-provider-action-gate.md',
    mutate: (source) => source
      .replace('  Compat -->|v3-provider-action-gate-01| E05\n', '')
      .replace(
        '```\n\nThe action lifecycle',
        '```\n\n%% Compat -->|v3-provider-action-gate-01| E05\n\nThe action lifecycle',
      ),
    diagnostic: /v3-provider-action-gate-01 must be Compat -> E05/u,
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
    name: 'Responses Relay accepts response.done as provider semantic terminal',
    path: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs',
    mutate: (source) => source.replace(
      'Some("response.completed") => Some("completed".to_string()),',
      'Some("response.completed" | "response.done") => Some("completed".to_string()),',
    ),
    diagnostic: /provider response\.done\/response\.requires_action|missing Some\("response\.completed"/u,
  },
  {
    name: 'Responses Relay event codec accepts response.done as provider semantic terminal',
    path: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime/responses_provider_event_codec.rs',
    mutate: (source) => source.replace(
      '| "response.done"',
      '| "response.done_removed"',
    ),
    diagnostic: /missing \| "response\.done"/u,
  },
  {
    name: 'Direct provider outcome accepts response.done as provider semantic terminal',
    path: 'v3/crates/routecodex-v3-runtime/src/hub_v1/provider_responses_event_classification.rs',
    mutate: (source) => source.replace(
      'if matches!(event_type, "response.completed" | "response.incomplete") {',
      'if matches!(event_type, "response.completed" | "response.incomplete" | "response.done") {',
    ),
    diagnostic: /missing if matches!\(event_type, "response\.completed" \| "response\.incomplete"\)/u,
  },
  {
    name: 'Direct SSE uses frame event metadata as provider semantic source',
    path: 'v3/crates/routecodex-v3-runtime/src/kernel/direct_runtime_helpers_stream.rs',
    mutate: (source) => source.replace(
      'pub(crate) fn inspect_direct_sse_raw_provider(raw: &str) -> V3DirectSseProviderFacts {\n',
      'pub(crate) fn inspect_direct_sse_raw_provider(raw: &str) -> V3DirectSseProviderFacts {\n    if event == "response.completed" {}\n',
    ),
    diagnostic: /SSE event metadata must not be used as provider semantic source/u,
  },
  {
    name: 'Relay target-resolution source errors are swallowed as exhaustion',
    path: 'v3/crates/routecodex-v3-runtime/src/provider_failure_runtime_policy.rs',
    mutate: (source) => source.replace(
      'V3RelayProviderTargetResolution::Failed(source) => {',
      'V3RelayProviderTargetResolution::Exhausted { attempted_candidates: _ } => {',
    ),
    diagnostic: /target-resolution source errors must not be swallowed as provider-pool exhaustion/u,
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
    name: 'V3 restores the retired Error05 recovery wait in direct execution',
    path: 'v3/crates/routecodex-v3-runtime/src/kernel.rs',
    mutate: (source) => source.replace(
      '    let mut trace = vec![',
      '    wait_for_error05_recovery();\n    let mut trace = vec![',
    ),
    diagnostic: /request execution must not wait on a provider action permit/u,
  },
  {
    name: 'V3 revives the retired provider action permit in direct execution',
    path: 'v3/crates/routecodex-v3-runtime/src/kernel.rs',
    mutate: (source) => source.replace(
      '    let mut trace = vec![',
      '    let _provider_action_permit = V3ProviderActionPermit;\n    let mut trace = vec![',
    ),
    diagnostic: /request execution must not wait on a provider action permit/u,
  },
  {
    name: 'V3 shortens the request-local error hold',
    path: 'v3/crates/routecodex-v3-runtime/src/provider_failure_runtime_policy.rs',
    mutate: (source) => source.replace(
      'std::time::Duration::from_secs(2)',
      'std::time::Duration::from_secs(1)',
    ),
    diagnostic: /each applicable error return must hold independently for two seconds/u,
  },
  {
    name: 'V3 Relay error path drops the independent return hold',
    path: 'v3/crates/routecodex-v3-runtime/src/provider_failure_runtime_policy.rs',
    mutate: (source) => source.replaceAll('hold_provider_error_return().await;', ''),
    diagnostic: /provider error policy must apply the independent return hold/u,
  },
  {
    name: 'V3 Direct error path drops the independent return hold',
    path: 'v3/crates/routecodex-v3-runtime/src/kernel/direct_runtime_helpers.rs',
    mutate: (source) => source.replaceAll('hold_provider_error_return().await;', ''),
    diagnostic: /provider error policy must apply the independent return hold/u,
  },
  {
    name: 'V3 Relay delays provider recovery actions',
    path: 'v3/crates/routecodex-v3-runtime/src/provider_failure_runtime_policy.rs',
    mutate: (source) => source.replace(
      'result.as_ref().is_ok_and(|outcome| {\n            matches!(outcome.decision.action, routecodex_v3_error::V3Error05ExecutionAction::ProjectTerminal)\n        })',
      'result.is_ok()',
    ),
    diagnostic: /final error hold must not delay provider recovery actions/u,
  },
  {
    name: 'V3 Direct delays provider recovery actions',
    path: 'v3/crates/routecodex-v3-runtime/src/kernel/direct_runtime_helpers.rs',
    mutate: (source) => source.replace(
      'result.as_ref().is_ok_and(|outcome| {\n            matches!(outcome.decision.action, V3Error05ExecutionAction::ProjectTerminal)\n        })',
      'result.is_ok()',
    ),
    diagnostic: /final error hold must not delay provider recovery actions/u,
  },
  {
    name: 'V3 Direct success bypasses the exact interface health binding',
    path: 'v3/crates/routecodex-v3-runtime/src/kernel/direct_runtime_helpers.rs',
    mutate: (source) => source.replace(
      'record_provider_success_in_failure_scope_for_interface(',
      'record_provider_success_in_failure_scope(',
    ),
    diagnostic: /does not call V3ProviderFailureRuntimeHealth::record_provider_success_in_failure_scope_for_interface/u,
  },
  {
    name: 'V3 provider error bypasses the exact interface health binding',
    path: 'v3/crates/routecodex-v3-runtime/src/provider_failure_runtime_policy.rs',
    mutate: (source) => source.replace(
      'record_real_provider_error_for_interface(',
      'record_real_provider_error_for_source(',
    ),
    diagnostic: /does not call V3ProviderFailureRuntimeHealth::record_real_provider_error_for_interface/u,
  },
  {
    name: 'V3 Responses public-entry binding is removed',
    path: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime_inner.rs',
    mutate: (source) => source.replaceAll(
      'execute_v3_responses_relay_runtime_inner_with_refill',
      'execute_v3_responses_relay_runtime_inner_without_refill',
    ),
    diagnostic: /declared symbol not found: execute_v3_responses_relay_runtime_inner_with_refill/u,
  },
  {
    name: 'V3 Direct SSE terminal binding is removed',
    path: 'v3/crates/routecodex-v3-runtime/src/kernel/direct_runtime_helpers_stream.rs',
    mutate: (source) => source.replaceAll(
      'collect_direct_sse_attempt_after_terminal',
      'collect_direct_sse_attempt_after_retired_terminal',
    ),
    diagnostic: /missing collect_direct_sse_attempt_after_terminal/u,
  },
  {
    name: 'CI drops canonical V3 verification',
    path: '.github/workflows/test.yml',
    mutate: (source) => source.replaceAll('npm --prefix v3 run verify:ci', 'echo v3-verification-skipped'),
    diagnostic: /missing npm --prefix v3 run verify:ci/u,
  },
];

function sourcePath(rel) {
  return resolve(v3Root, '..', rel);
}

function copyFixtureSurface(root) {
  for (const rel of copied) {
    const target = resolve(root, rel);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(sourcePath(rel), target, { recursive: true });
  }
}

const failures = [];
const baselineRoot = mkdtempSync(join(tmpdir(), 'v3-provider-action-gate-baseline-'));
copyFixtureSurface(baselineRoot);
const baseline = spawnSync(process.execPath, [verifier], {
  cwd: baselineRoot,
  encoding: 'utf8',
  env: { ...process.env, ROUTECODEX_V3_SOURCE_ROOT: baselineRoot },
});
rmSync(baselineRoot, { recursive: true, force: true });
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
    copyFixtureSurface(root);
    const target = resolve(root, testCase.path);
    const original = readFileSync(target, 'utf8');
    const mutated = testCase.mutate(original);
    if (mutated === original) {
      failures.push(`${testCase.name}: mutation did not change ${testCase.path}`);
      continue;
    }
    writeFileSync(target, mutated);
    const result = spawnSync(process.execPath, [verifier], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ROUTECODEX_V3_SOURCE_ROOT: root },
    });
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
