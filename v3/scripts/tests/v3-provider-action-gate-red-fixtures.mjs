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
  'v3/crates/routecodex-v3-runtime/src/provider_action_gate.rs',
  'v3/crates/routecodex-v3-runtime/tests/provider_action_gate_session_isolation_contract.rs',
  'v3/crates/routecodex-v3-runtime/src/provider_failure_runtime_policy.rs',
  'v3/crates/routecodex-v3-runtime/src/provider_probe_lifecycle.rs',
  'v3/crates/routecodex-v3-runtime/src/provider_precool_hold.rs',
  'v3/crates/routecodex-v3-runtime/src/provider_failure_runtime_policy_health.rs',
  'v3/crates/routecodex-v3-runtime/src/provider_failure_runtime_policy_events.rs',
  'v3/crates/routecodex-v3-runtime/src/provider_failure_runtime_policy_configured.rs',
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
  'v3/crates/routecodex-v3-runtime/tests/provider_action_gate_contract.rs',
  'v3/crates/routecodex-v3-runtime/tests/openai_chat_relay_runtime_integration.rs',
  'v3/crates/routecodex-v3-runtime/tests/gemini_relay_runtime_integration.rs',
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
const positiveCases = [
  {
    name: 'typed macro calls accept an omitted optional trailing comma',
    path: 'v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs',
    mutate: (source) => source.replace(/response_processing_code,(\s*\)\s*\.await\?)/gu, 'response_processing_code$1'),
  },
  {
    name: 'cleaned Anthropic owner passes through the live shared typed-action relation',
    path: 'v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs',
    mutate: (source) => source.replace(
      'use super::relay_runtime_shared::provider_response_governance_failure;',
      '// Positive fixture: this owner relies on the shared typed-action consumer.\nuse super::relay_runtime_shared::provider_response_governance_failure;',
    ),
  },
];
const cases = [
  {
    name: 'shared policy drops only its typed response code argument',
    path: 'v3/crates/routecodex-v3-runtime/src/hub_v1/relay_runtime_shared.rs',
    mutate: (source) => source.replace('        state,\n        response_processing_code,\n        active_source,', '        state,\n        None,\n        active_source,'),
    diagnostic: /policy call must forward response_processing_code/u,
  },
  {
    name: 'typed macro invocation survives only in a dead expression arm',
    path: 'v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs',
    mutate: (source) => source.replace(
      /if let Some\(failure\) = (active_failure!\((?:(?!active_failure!)[\s\S])*?response_processing_code,\s*\)\s*\.await\?)/u,
      'if let Some(failure) = if false { $1 } else { Some(failure) }',
    ),
    diagnostic: /response-code call .* must directly drive the failure branch/u,
  },
  {
    name: 'Direct inner policy bypasses the owning failure recorder',
    path: 'v3/crates/routecodex-v3-runtime/src/kernel/direct_runtime_helpers.rs',
    mutate: (source) => source.replace('match record_v3_direct_provider_failure_record(', 'match bypassed_direct_failure_record('),
    diagnostic: /v3-provider-action-gate-36:.*does not call record_v3_direct_provider_failure_record/u,
  },
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
    name: 'runtime revives a process-global gate',
    path: 'v3/crates/routecodex-v3-runtime/src/provider_failure_runtime_policy.rs',
    mutate: (source) => source.replaceAll(
      'action_gate: V3ProviderActionGate::default()',
      'action_gate: V3ProviderActionGate::process_shared()',
    ),
    diagnostic: /missing action_gate: V3ProviderActionGate::default\(\)/u,
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
      'malformed_then_terminal_sse_keeps_fresh_request_immediate',
      'malformed_then_terminal_sse_waits_for_a_fresh_request',
    ),
    diagnostic: /missing active Rust test malformed_then_terminal_sse_keeps_fresh_request_immediate/u,
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
    name: 'terminal transition is removed',
    path: 'v3/crates/routecodex-v3-runtime/src/provider_action_gate.rs',
    mutate: (source) => source.replace('pub fn commit_terminal_admission(', 'pub fn bypass_terminal_transition('),
    diagnostic: /missing pub fn commit_terminal_admission\(/u,
  },
  {
    name: 'terminal Error06 projection bypasses the failure gate',
    path: 'v3/crates/routecodex-v3-runtime/src/provider_action_gate.rs',
    mutate: (source) => source.replace(
      'record_failure_and_commit_terminal_projection',
      'project_terminal_without_wait',
    ),
    diagnostic: /missing record_failure_and_commit_terminal_projection/u,
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
    name: 'V3 waiter ignores an already-owned exact permit',
    path: 'v3/crates/routecodex-v3-runtime/src/provider_action_gate.rs',
    mutate: (source) => source.replace(
      '(!self.admit_action || !exact_has_active_admission)',
      '(!self.admit_action || true)',
    ),
    diagnostic: /missing \(!self\.admit_action \|\| !exact_has_active_admission\)/u,
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
    name: 'Responses Relay re-introduces retained recovery state',
    path: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime_inner.rs',
    mutate: (source) => `${source}\nlet mut pending_provider_action_recovery = None;\n`,
    diagnostic: /Responses Relay must not wait or admit on the request path/u,
  },
  {
    name: 'V3 new failure revokes an already-owned exact permit',
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
      'key.provider_scope == *provider_scope',
      'key.provider_scope.server_id == provider_scope.server_id\n                        && key.provider_scope.routing_group == provider_scope.routing_group',
    ),
    diagnostic: /provider success may release only its exact provider scope/u,
  },
  {
    name: 'Direct re-introduces a provider action recovery wait',
    path: 'v3/crates/routecodex-v3-runtime/src/kernel.rs',
    mutate: (source) => `${source}\nfn __fixture_wait() { let _ = wait_for_error05_recovery; }\n`,
    diagnostic: /Direct must not wait or admit on the request path/u,
  },
  {
    name: 'provider change restarts isolated delay',
    path: 'v3/crates/routecodex-v3-runtime/src/provider_action_gate.rs',
    mutate: (source) => source.replaceAll('sustained_delay_ms()', 'bypassed_sustained_delay_ms()'),
    diagnostic: /missing state\.next_admission_at/u,
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
      'if !Self::commit_terminal_generation_locked(',
      'if !Self::bypass_terminal_generation_locked(',
    ),
    diagnostic: /does not call V3ProviderActionGate::commit_terminal_generation_locked/u,
  },
  {
    name: 'V3 terminal projection revokes an active exact-key provider permit',
    path: 'v3/crates/routecodex-v3-runtime/src/provider_action_gate.rs',
    mutate: (source) => source.replace(
      '!require_admission && state.admitted_generation.is_some()',
      'false',
    ),
    diagnostic: /missing !require_admission && state\.admitted_generation\.is_some\(\)/u,
  },
  {
    name: 'V3 terminal admission leaves only a commented atomic commit',
    path: 'v3/crates/routecodex-v3-runtime/src/provider_action_gate.rs',
    mutate: (source) => source.replace(
      'if !Self::commit_terminal_generation_locked(',
      'if !Self::bypass_terminal_generation_locked( /* Self::commit_terminal_generation_locked( */',
    ),
    diagnostic: /does not call V3ProviderActionGate::commit_terminal_generation_locked/u,
  },
  {
    name: 'V3 terminal admission shadows the atomic commit symbol',
    path: 'v3/crates/routecodex-v3-runtime/src/provider_action_gate.rs',
    mutate: (source) => source.replace(
      'if !Self::commit_terminal_generation_locked(',
      'let commit_terminal_generation_locked = || true;\n        if !commit_terminal_generation_locked() {',
    ),
    diagnostic: /shadows declared callee V3ProviderActionGate::commit_terminal_generation_locked/u,
  },
  {
    name: 'V3 terminal admission calls the right method name on the wrong receiver',
    path: 'v3/crates/routecodex-v3-runtime/src/provider_action_gate.rs',
    mutate: (source) => source
      .replace(
        'impl V3ProviderActionGate {\n',
        'struct UnrelatedGate;\nimpl UnrelatedGate {\n    fn commit_terminal_generation(&self, _key: &V3ProviderActionGateKey, _generation: u64, _require_admission: bool) -> Result<bool, String> { Ok(true) }\n}\n\nimpl V3ProviderActionGate {\n',
      )
      .replace(
        'impl V3ProviderActionGate {\n',
        'struct UnrelatedGate;\nimpl UnrelatedGate {\n    fn commit_terminal_generation_locked(_states: &mut HashMap<V3ProviderActionGateKey, V3ProviderActionGateState>, _key: &V3ProviderActionGateKey, _generation: u64, _require_admission: bool, _now: Instant) -> Result<bool, String> { Ok(true) }\n}\n\nimpl V3ProviderActionGate {\n',
      )
      .replace(
        'if !Self::commit_terminal_generation_locked(',
        'if !UnrelatedGate::commit_terminal_generation_locked(',
      ),
    diagnostic: /does not call V3ProviderActionGate::commit_terminal_generation_locked/u,
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
    name: 'V3 manifest revives a request-path admission contract',
    path: 'docs/architecture/manifests/v3.provider_action_gate.mainline.yml',
    mutate: (source) => source.replace(
      'request_independence:\n',
      'admission_permit:\n  owner_type: V3ProviderActionPermit\nrequest_independence:\n',
    ),
    diagnostic: /request-path admission contracts must be physically removed/u,
  },
  {
    name: 'V3 manifest permits request-path admission waiting',
    path: 'docs/architecture/manifests/v3.provider_action_gate.mainline.yml',
    mutate: (source) => source.replace(
      '  request_path_admission_or_wait: forbidden\n',
      '  request_path_admission_or_wait: allowed\n',
    ),
    diagnostic: /request-path admission and wait must stay forbidden/u,
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
      '  - resource_id: v3.error.provider_action_gate\n    resource_kind: process_local_background_observation\n    lifecycle: v3.provider_action_gate.mainline\n    owner_crate: routecodex-v3-runtime\n',
      '  - resource_id: v3.error.provider_action_gate\n    resource_kind: process_local_background_observation\n    lifecycle: v3.provider_action_gate.mainline\n    owner_crate: routecodex-v3-server\n',
    ),
    diagnostic: /V3 lifecycle\/chain\/owner binding drift/u,
  },
  {
    name: 'V3 wiki fabricates a terminal commit downstream edge',
    path: 'docs/architecture/wiki/v3-provider-action-gate.md',
    mutate: (source) => source.replace(
      '  E05 -->|v3-provider-action-gate-06| TerminalCommit\n',
      '  E05 -->|v3-provider-action-gate-06| TerminalCommit\n  TerminalCommit -->|fabricated gate witness| E05\n',
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
    name: 'Direct failure ingress bypasses active-key outcome custody',
    path: 'v3/crates/routecodex-v3-runtime/src/kernel.rs',
    mutate: (source) => source.replaceAll(
      'run_v3_direct_provider_failure_policy_with_active_keys(',
      'run_v3_direct_provider_failure_policy(',
    ),
    diagnostic: /does not call run_v3_direct_provider_failure_policy_with_active_keys/u,
  },
  {
    name: 'Responses Relay failure ingress bypasses active-key outcome custody',
    path: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs',
    mutate: (source) => source.replaceAll(
      'run_v3_relay_provider_failure_policy_with_response_source_and_active_keys(',
      'run_v3_relay_provider_failure_policy_with_response_source(',
    ),
    diagnostic: /does not call run_v3_relay_provider_failure_policy_with_response_source_and_active_keys/u,
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
    name: 'Required gate test name survives only in a comment',
    path: 'v3/crates/routecodex-v3-runtime/tests/provider_action_gate_contract.rs',
    mutate: (source) => source.replace(
      '#[tokio::test]\nasync fn isolated_failure_blocks_one_action_for_at_least_one_second()',
      '// isolated_failure_blocks_one_action_for_at_least_one_second\nasync fn disabled_isolated_failure_test()',
    ),
    diagnostic: /missing active Rust test isolated_failure_blocks_one_action_for_at_least_one_second/u,
  },
  {
    name: 'CI drops canonical V3 verification',
    path: '.github/workflows/test.yml',
    mutate: (source) => source.replaceAll('npm --prefix v3 run verify:ci', 'echo v3-verification-skipped'),
    diagnostic: /missing npm --prefix v3 run verify:ci/u,
  },
  {
    name: 'Anthropic real failure calls disappear behind typed-action decoys',
    path: 'v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs',
    mutate: (source) => source
      .replace(
        'use super::relay_runtime_shared::{',
        'use routecodex_v3_error::V3Error05ExecutionAction;\n'
          + "const _: fn(&V3Error05ExecutionAction) -> &'static str =\n"
          + '    V3Error05ExecutionAction::observability_label;\n'
          + '// V3Error05ExecutionAction decoy\n'
          + 'use super::relay_runtime_shared::{',
      )
      .replaceAll('active_failure!(', 'bypass_provider_failure!(')
      .replaceAll(
        'handle_provider_failure_with_response_code_and_active_keys(',
        'bypass_provider_failure_with_response_code(',
      ),
    diagnostic: /active_failure macro must delegate|expected eight live active_failure calls/u,
  },
  {
    name: 'Anthropic response-code caller disappears while ordinary caller remains',
    path: 'v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs',
    mutate: (source) => source.replaceAll('response_processing_code,', ''),
    diagnostic: /expected two response-code calls/u,
  },
  ...['both', 'first', 'second'].map((site) => ({
    name: `Anthropic ${site} response-code caller loses its final typed code`,
    path: 'v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs',
    mutate: (source) => {
      let callIndex = 0;
      return source.replace(
        /response_processing_code,(\s*\)\s*\.await\?)/gu,
        (argument, tail) => {
          callIndex += 1;
          return site === 'both' || callIndex === (site === 'first' ? 1 : 2)
            ? `None,${tail}`
            : argument;
        },
      );
    },
    diagnostic: /response-code call \d+ must forward response_processing_code as its final argument/u,
  })),
  {
    name: 'Shared policy output is disconnected behind a dead nested policy call',
    path: 'v3/crates/routecodex-v3-runtime/src/hub_v1/relay_runtime_shared.rs',
    mutate: (source) => source.replace(
      'let mut result = match crate::provider_failure_runtime_policy::run_v3_relay_provider_failure_policy_with_response_source_and_active_keys(',
      'if false { crate::provider_failure_runtime_policy::run_v3_relay_provider_failure_policy_with_response_source_and_active_keys(); }\n'
        + '    let mut result = match unrelated_policy(',
    ),
    diagnostic: /must bind the top-level policy result/u,
  },
  {
    name: 'Shared policy returns a different Ok binding',
    path: 'v3/crates/routecodex-v3-runtime/src/hub_v1/relay_runtime_shared.rs',
    mutate: (source) => source.replace('Ok(result) => result,', 'Ok(result) => unrelated_result,'),
    diagnostic: /must return the policy Ok binding/u,
  },
  ...[
    'let result = unrelated_result;',
    'result = unrelated_result;',
    'result.decision = unrelated_decision;',
    'result.decision.action = unrelated_action;',
    'let decision = unrelated_decision;',
    'let action = unrelated_action;',
  ].map((statement) => ({
    name: `Shared policy binding changes before consumption: ${statement}`,
    path: 'v3/crates/routecodex-v3-runtime/src/hub_v1/relay_runtime_shared.rs',
    mutate: (source) => source.replace(
      'match result.decision.action {',
      `${statement}\n    match result.decision.action {`,
    ),
    diagnostic: /policy result must reach the action match unchanged/u,
  })),
  {
    name: 'Shared catch-all mentions the missing typed variant only inside its body',
    path: 'v3/crates/routecodex-v3-runtime/src/hub_v1/relay_runtime_shared.rs',
    mutate: (source) => source.replace(
      'V3Error05ExecutionAction::Reselect => {',
      'other => { let _ = V3Error05ExecutionAction::Reselect;',
    ),
    diagnostic: /typed action match must (?:handle V3Error05ExecutionAction::Reselect|use only explicit typed action patterns)/u,
  },
  {
    name: 'Anthropic shared failure delegation is disconnected',
    path: 'v3/crates/routecodex-v3-runtime/src/hub_v1/relay_runtime_shared.rs',
    mutate: (source) => source.replaceAll(
      '    handle_provider_failure_with_response_code_and_active_keys(\n',
      '    bypass_provider_failure_with_response_code(\n',
    ),
    diagnostic: /does not call handle_provider_failure_with_response_code_and_active_keys/u,
  },
  {
    name: 'Shared typed action variants survive outside the required match',
    path: 'v3/crates/routecodex-v3-runtime/src/hub_v1/relay_runtime_shared.rs',
    mutate: (source) => source.replace(
      'match result.decision.action {',
      'match bypassed_action {',
    ),
    diagnostic: /must match result\.decision\.action/u,
  },
  {
    name: 'Shared typed action match drops a required variant',
    path: 'v3/crates/routecodex-v3-runtime/src/hub_v1/relay_runtime_shared.rs',
    mutate: (source) => source.replace(
      'V3Error05ExecutionAction::Reselect =>',
      'V3Error05ExecutionAction::Bypass =>',
    ),
    diagnostic: /typed action match must handle V3Error05ExecutionAction::Reselect/u,
  },
  {
    name: 'Shared typed action match hides a missing variant with a wildcard',
    path: 'v3/crates/routecodex-v3-runtime/src/hub_v1/relay_runtime_shared.rs',
    mutate: (source) => source.replace(
      'V3Error05ExecutionAction::RejectNonProviderError =>',
      '_ =>',
    ),
    diagnostic: /typed action match must (?:handle V3Error05ExecutionAction::RejectNonProviderError|not use a wildcard arm)/u,
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

for (const testCase of positiveCases) {
  const root = mkdtempSync(join(tmpdir(), 'v3-provider-action-gate-positive-'));
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
    if (result.status !== 0) {
      const output = `${result.stdout || ''}\n${result.stderr || ''}`;
      failures.push(`${testCase.name}: positive fixture failed: ${output.slice(-1200)}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
console.log(
  `[test:v3-provider-action-gate-red-fixtures] ok (${positiveCases.length} positive, ${cases.length} forbidden mutations)`,
);
