#!/usr/bin/env node
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

const repo = process.cwd();
const verifier = resolve(repo, 'scripts/architecture/verify-v3-stopless-resource-control.mjs');
const copied = [
  'package.json',
  'docs/architecture/v3-resource-operation-map.yml',
  'docs/architecture/v3-function-map.yml',
  'docs/architecture/v3-mainline-call-map.yml',
  'docs/architecture/v3-verification-map.yml',
  'docs/architecture/manifests/v3.servertool_hook_skeleton_lifecycle.mainline.yml',
  'docs/architecture/snapshot-stage-contract.md',
  'docs/design/v3-stopless-schema-guidance-activation-contract.md',
  '.agents/skills/rcc-dev-skills/references/95-v3-stopless-sop.md',
  'scripts/architecture/verify-v3-stopless-resource-control.mjs',
  'scripts/tests/v3-stopless-resource-control-red-fixtures.mjs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/common.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/req_inbound_02_normalized.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/req_outbound_07_provider_semantic.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/resp_continuation_04_committed.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_types.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/servertool_hooks.rs',
  'v3/crates/routecodex-v3-runtime/src/kernel.rs',
  'v3/crates/routecodex-v3-runtime/src/kernel/direct_state.rs',
  'v3/crates/routecodex-v3-runtime/src/kernel/direct_stopless.rs',
  'v3/crates/routecodex-v3-runtime/src/kernel/direct_runtime_helpers.rs',
  'v3/crates/routecodex-v3-runtime/tests/responses_relay_local_continuation_integration.rs',
  'v3/crates/routecodex-v3-runtime/tests/responses_direct_remote_continuation_integration.rs',
  'v3/crates/routecodex-v3-runtime/tests/responses_direct_tool_passthrough.rs',
  'v3/crates/routecodex-v3-debug/src/lib.rs',
];

function mutateYaml(source, mutate) {
  const document = YAML.parse(source);
  mutate(document);
  return YAML.stringify(document);
}

function edge(document, stepId) {
  return document.chains.flatMap((chain) => chain.edges ?? []).find((item) => item.step_id === stepId);
}

const cases = [

  {
    name: 'Resp03 data node carries StoplessCenter control state',
    path: 'v3/crates/routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs',
    marker: '    pub(crate) servertool_action: V3HubServertoolResponseAction,\n',
    replacement: '    pub(crate) servertool_action: V3HubServertoolResponseAction,\n    pub(crate) leaked_control: Option<V3StoplessCenterState>,\n',
    diagnostic: /Resp03 data node must not carry StoplessCenter control state/u,
  },
  {
    name: 'Resp04 data node carries StoplessCenter control state',
    path: 'v3/crates/routecodex-v3-runtime/src/hub_v1/resp_continuation_04_committed.rs',
    marker: '    pub(crate) canonical_context: Option<V3HubRelayCanonicalResponseContext>,\n',
    replacement: '    pub(crate) canonical_context: Option<V3HubRelayCanonicalResponseContext>,\n    pub(crate) leaked_control: Option<V3StoplessCenterState>,\n',
    diagnostic: /Resp04 continuation data node must not carry StoplessCenter control state/u,
  },

  {
    name: 'activation contract stops requiring same-turn schema guidance',
    path: 'docs/architecture/manifests/v3.servertool_hook_skeleton_lifecycle.mainline.yml',
    marker: '  request_schema_guidance_required: true\n',
    replacement: '  request_schema_guidance_required: false\n',
    diagnostic: /activation_contract\.request_schema_guidance_required must equal true/u,
  },
  {
    name: 'activation contract mislabels activation truth owner',
    path: 'docs/architecture/manifests/v3.servertool_hook_skeleton_lifecycle.mainline.yml',
    marker: '  activation_truth_owner: metadata_center_stopless_state_machine\n',
    replacement: '  activation_truth_owner: loose_runtime_marker\n',
    diagnostic: /activation_contract\.activation_truth_owner must equal "metadata_center_stopless_state_machine"/u,
  },
  {
    name: 'activation contract allows response intercept without marker',
    path: 'docs/architecture/manifests/v3.servertool_hook_skeleton_lifecycle.mainline.yml',
    marker: '  response_intercept_without_activation: forbidden\n',
    replacement: '  response_intercept_without_activation: allowed\n',
    diagnostic: /activation_contract\.response_intercept_without_activation must equal "forbidden"/u,
  },
  {
    name: 'activation contract allows loose activation marker',
    path: 'docs/architecture/manifests/v3.servertool_hook_skeleton_lifecycle.mainline.yml',
    marker: '  loose_activation_marker: forbidden\n',
    replacement: '  loose_activation_marker: allowed\n',
    diagnostic: /activation_contract\.loose_activation_marker must equal "forbidden"/u,
  },
  {
    name: 'activation contract loses schema_guidance_active state field',
    path: 'docs/architecture/manifests/v3.servertool_hook_skeleton_lifecycle.mainline.yml',
    marker: '    - schema_guidance_active\n',
    replacement: '',
    diagnostic: /activation_contract\.activation_state_fields must include schema_guidance_active/u,
  },
  {
    name: 'activation contract loses accepted stop schema evidence',
    path: 'docs/architecture/manifests/v3.servertool_hook_skeleton_lifecycle.mainline.yml',
    marker: '    - accepted_stop_schema\n',
    replacement: '',
    diagnostic: /activation_contract\.accepted_stop_evidence must include accepted_stop_schema/u,
  },
  {
    name: 'activation contract loses Anthropic validation exception',
    path: 'docs/architecture/manifests/v3.servertool_hook_skeleton_lifecycle.mainline.yml',
    marker: '  provider_validation_exception: disable_activation_when_guidance_injection_is_provider_invalid\n',
    replacement: '  provider_validation_exception: force_schema_guidance\n',
    diagnostic: /activation_contract\.provider_validation_exception must equal "disable_activation_when_guidance_injection_is_provider_invalid"/u,
  },

  {
    name: 'activation contract forbids Direct scoped StoplessCenter writes',
    path: 'docs/architecture/manifests/v3.servertool_hook_skeleton_lifecycle.mainline.yml',
    marker: '  direct_stopless_center_write: direct_scoped_only\n',
    replacement: '  direct_stopless_center_write: forbidden\n',
    diagnostic: /activation_contract\.direct_stopless_center_write must equal "direct_scoped_only"/u,
  },
  {
    name: 'activation contract stops applying to direct path',
    path: 'docs/architecture/manifests/v3.servertool_hook_skeleton_lifecycle.mainline.yml',
    marker: '    - responses_direct\n',
    replacement: '',
    diagnostic: /activation_contract\.applies_to_paths must include responses_direct/u,
  },
  {
    name: 'design doc allows no-marker no-op projection',
    path: 'docs/design/v3-stopless-schema-guidance-activation-contract.md',
    marker: 'Inactive state, no intercept',
    replacement: 'no marker projects no-op',
    diagnostic: /activation contract must not allow no marker projects no-op/u,
  },
  {
    name: 'runtime adapter promoted to semantic owner',
    path: 'docs/architecture/v3-resource-operation-map.yml',
    marker: '    owner_node: StoplessCenterMetadataControl\n',
    replacement: '    owner_node: V3ResponsesRelayStoplessControlState\n',
    diagnostic: /owner_node must equal "StoplessCenterMetadataControl"/u,
  },
  {
    name: 'StoplessCenter moved out of Metadata Center lifecycle',
    path: 'docs/architecture/v3-resource-operation-map.yml',
    marker: '    lifecycle: v3.metadata.center.mainline\n    owner_feature_id: v3.servertool_hook_skeleton_lifecycle\n',
    replacement: '    lifecycle: v3.servertool_hook_skeleton_lifecycle\n    owner_feature_id: v3.servertool_hook_skeleton_lifecycle\n',
    diagnostic: /lifecycle must equal "v3\.metadata\.center\.mainline"/u,
  },
  {
    name: 'CLI carries scope',
    path: 'docs/architecture/v3-resource-operation-map.yml',
    marker: 'cli_contract: { carries_scope: false, carries_state: false, parameters: none',
    replacement: 'cli_contract: { carries_scope: true, carries_state: false, parameters: none',
    diagnostic: /cli_contract\.carries_scope must equal false/u,
  },
  {
    name: 'CLI carries StoplessCenter state',
    path: 'docs/architecture/v3-resource-operation-map.yml',
    marker: 'cli_contract: { carries_scope: false, carries_state: false, parameters: none',
    replacement: 'cli_contract: { carries_scope: false, carries_state: true, parameters: stopless_state',
    diagnostic: /cli_contract\.carries_state must equal false/u,
  },
  {
    name: 'generic Hub closeout claims StoplessCenter',
    path: 'docs/architecture/v3-mainline-call-map.yml',
    marker: 'step_id: v3-hub-relay-closeout-03,',
    replacement: 'step_id: v3-hub-relay-closeout-03,',
    mutate(source) {
      return mutateYaml(source, (document) => {
        edge(document, 'v3-hub-relay-closeout-03').resource_flow.side_channel_writes = [resourceId];
      });
    },
    diagnostic: /undeclared cross-SOP StoplessCenter access outside/u,
  },
  {
    name: 'server aggregate edge claims control write',
    path: 'docs/architecture/v3-mainline-call-map.yml',
    mutate(source) {
      return mutateYaml(source, (document) => {
        edge(document, 'v3-responses-relay-server-02').resource_flow.side_channel_writes = [resourceId];
      });
    },
    diagnostic: /undeclared cross-SOP StoplessCenter access outside|aggregate server edge must not claim control\/resource writes/u,
  },
  {
    name: 'local continuation carrier owns StoplessCenter',
    path: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs',
    marker: "struct V3ResponsesRelayLocalContinuationExecution<'state> {\n",
    replacement: "struct V3ResponsesRelayLocalContinuationExecution<'state> {\n    stopless_control: &'state V3ResponsesRelayStoplessControlState,\n",
    diagnostic: /local continuation execution must not own stopless_control/u,
  },
  {
    name: 'request fallback scope can write StoplessCenter',
    path: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_types.rs',
    marker: 'session_id.starts_with("request:")',
    replacement: 'session_id.starts_with("routecodex-disabled-request-fallback:")',
    diagnostic: /request-fallback scope guard missing session_id\.starts_with\("request:"\)/u,
  },

  {
    name: 'Direct request fallback scope can write StoplessCenter',
    path: 'v3/crates/routecodex-v3-runtime/src/kernel/direct_state.rs',
    marker: 'session_id.starts_with("request:")',
    replacement: 'session_id.starts_with("routecodex-disabled-request-fallback:")',
    diagnostic: /missing session_id\.starts_with\("request:"\)|request-fallback scope guard missing session_id\.starts_with\("request:"\)/u,
  },
  {
    name: 'StoplessCenter state loses max_stop_budget field',
    path: 'v3/crates/routecodex-v3-runtime/src/hub_v1/common.rs',
    marker: '    max_stop_budget: u32,\n',
    replacement: '',
    diagnostic: /V3StoplessCenterState missing max_stop_budget/u,
  },
  {
    name: 'StoplessCenter state loses updated_at field',
    path: 'v3/crates/routecodex-v3-runtime/src/hub_v1/common.rs',
    marker: '    updated_at: u64,\n',
    replacement: '',
    diagnostic: /V3StoplessCenterState missing updated_at/u,
  },
  {
    name: 'StoplessCenter state loses next_step_prompt field',
    path: 'v3/crates/routecodex-v3-runtime/src/hub_v1/common.rs',
    marker: '    next_step_prompt: Option<String>,\n',
    replacement: '',
    diagnostic: /V3StoplessCenterState missing next_step_prompt/u,
  },
  {
    name: 'resource map loses StoplessCenter updated_at field',
    path: 'docs/architecture/v3-resource-operation-map.yml',
    marker: ', updated_at]',
    replacement: ']',
    diagnostic: /state_fields must include updated_at/u,
  },
  {
    name: 'manifest loses StoplessCenter next_step_prompt field',
    path: 'docs/architecture/manifests/v3.servertool_hook_skeleton_lifecycle.mainline.yml',
    marker: ', next_step_prompt,',
    replacement: ', ',
    diagnostic: /state_fields must include next_step_prompt/u,
  },
  {
    name: 'resource map loses StoplessCenter next_step_prompt field',
    path: 'docs/architecture/v3-resource-operation-map.yml',
    marker: ', next_step_prompt,',
    replacement: ', ',
    diagnostic: /state_fields must include next_step_prompt/u,
  },

  {
    name: 'resource map loses Direct StoplessCenter implementation handle',
    path: 'docs/architecture/v3-resource-operation-map.yml',
    marker: ', V3ResponsesDirectStoplessControlState(adapter_runtime_handle)',
    replacement: '',
    diagnostic: /implementation_handles must classify V3ResponsesDirectStoplessControlState/u,
  },
  {
    name: 'resource map loses Direct StoplessCenter writer',
    path: 'docs/architecture/v3-resource-operation-map.yml',
    marker: ', V3ResponsesDirectStoplessControlState::store_for_scope',
    replacement: '',
    diagnostic: /allowed_writers must include V3ResponsesDirectStoplessControlState::store_for_scope/u,
  },
  {
    name: 'resource map loses Direct StoplessCenter reader',
    path: 'docs/architecture/v3-resource-operation-map.yml',
    marker: ', V3ResponsesDirectStoplessControlState::load_for_scope',
    replacement: '',
    diagnostic: /allowed_readers must include V3ResponsesDirectStoplessControlState::load_for_scope/u,
  },
  {
    name: 'direct mainline chain loses StoplessCenter control chain id',
    path: 'docs/architecture/v3-mainline-call-map.yml',
    mutate(source) {
      return mutateYaml(source, (document) => {
        document.chains.find(
          (chain) => chain.chain_id === 'v3.direct_stopless_metadata_center',
        ).chain_id = 'v3.direct_stopless_metadata_center_removed';
      });
    },
    diagnostic: /missing chain v3\.direct_stopless_metadata_center/u,
  },
  {
    name: 'direct runtime writes Relay StoplessCenter handle',
    path: 'v3/crates/routecodex-v3-runtime/src/kernel.rs',
    marker: 'use crate::hub_v1::{\n',
    replacement: 'use crate::hub_v1::{\n    V3ResponsesRelayStoplessControlState,\n',
    diagnostic: /Direct stopless control must not reference Relay StoplessCenter handle/u,
  },
  {
    name: 'response hook revives stopless client CLI projection',
    path: 'v3/crates/routecodex-v3-runtime/src/hub_v1/servertool_hooks.rs',
    marker: 'pub fn apply_v3_tool_call_servertool_hook_at_resp03(\n',
    replacement: 'fn build_stopless_cli_projection_payload() {}\n\npub fn apply_v3_tool_call_servertool_hook_at_resp03(\n',
    diagnostic: /stopless control CLI projection must not enter client business payload/u,
  },
  {
    name: 'manifest forbids designed Req04 current-turn projection',
    path: 'docs/architecture/manifests/v3.servertool_hook_skeleton_lifecycle.mainline.yml',
    marker: '  req04_injection: allowed_registered_only\n',
    replacement: '  req04_injection: forbidden\n',
    diagnostic: /current_turn_protocol_projection\.req04_injection must equal "allowed_registered_only"/u,
  },
  {
    name: 'manifest allows Resp03 stripping without matching provenance',
    path: 'docs/architecture/manifests/v3.servertool_hook_skeleton_lifecycle.mainline.yml',
    marker: '  resp03_stripping: allowed_matching_provenance_only\n',
    replacement: '  resp03_stripping: allowed_unscoped\n',
    diagnostic: /current_turn_protocol_projection\.resp03_stripping must equal "allowed_matching_provenance_only"/u,
  },
  {
    name: 'manifest allows Stopless history mutation',
    path: 'docs/architecture/manifests/v3.servertool_hook_skeleton_lifecycle.mainline.yml',
    marker: '  history_mutation: forbidden\n',
    replacement: '  history_mutation: allowed\n',
    diagnostic: /current_turn_protocol_projection\.history_mutation must equal "forbidden"/u,
  },
  {
    name: 'manifest allows Stopless semantics inside continuation immutable interval',
    path: 'docs/architecture/manifests/v3.servertool_hook_skeleton_lifecycle.mainline.yml',
    marker: '  continuation_immutable_interval_semantics: forbidden\n',
    replacement: '  continuation_immutable_interval_semantics: allowed\n',
    diagnostic: /current_turn_protocol_projection\.continuation_immutable_interval_semantics must equal "forbidden"/u,
  },
  {
    name: 'ReqInbound steals Stopless current-turn injection ownership',
    path: 'v3/crates/routecodex-v3-runtime/src/hub_v1/req_inbound_02_normalized.rs',
    marker: 'use super::{\n',
    replacement: 'fn inject_stopless_guidance() {}\n\nuse super::{\n',
    diagnostic: /Stopless current-turn projection must remain owned by Req04\/Resp03/u,
  },
  {
    name: 'manifest revives no-op lifecycle explanation',
    path: 'docs/architecture/manifests/v3.servertool_hook_skeleton_lifecycle.mainline.yml',
    marker: '  model_visible_bridge_transparency: required\n  must_include:\n',
    replacement: '  must_explain:\n    - no-op only closes the client tool round\n  must_include:\n',
    diagnostic: /model_visible_bridge_transparency.*must equal "required"|must_explain must not revive no-op lifecycle explanations/u,
  },
  {
    name: 'manifest stops forbidding no-op in provider-visible prompt',
    path: 'docs/architecture/manifests/v3.servertool_hook_skeleton_lifecycle.mainline.yml',
    marker: '    - no-op\n',
    replacement: '',
    diagnostic: /guidance_rewrite\.forbidden_model_visible must include no-op/u,
  },
  {
    name: 'snapshot restores StoplessCenter truth',
    path: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs',
    marker: 'use serde_json::{json, Map, Value};\n',
    replacement: 'use serde_json::{json, Map, Value};\nfn restore_stopless_from_snapshot_runtime_json() {}\n',
    diagnostic: /snapshot\/debug artifacts must not restore StoplessCenter control truth/u,
  },
  {
    name: 'snapshot contract loses observability-only lock',
    path: 'docs/architecture/snapshot-stage-contract.md',
    marker: 'diagnostic correlation only',
    replacement: 'diagnostic lookup',
    diagnostic: /snapshot-stage-contract\.md missing diagnostic correlation only/u,
  },
];

const resourceId = 'v3.metadata.runtime_control_stopless';
const failures = [];

for (const fixture of cases) {
  const root = mkdtempSync(join(tmpdir(), 'v3-stopless-resource-control-red-'));
  try {
    for (const rel of copied) cpSync(resolve(repo, rel), resolve(root, rel), { recursive: true });
    const target = resolve(root, fixture.path);
    const original = readFileSync(target, 'utf8');
    let mutated;
    if (fixture.mutate) {
      mutated = fixture.mutate(original);
    } else {
      if (!original.includes(fixture.marker)) {
        failures.push(`${fixture.name}: mutation marker missing`);
        continue;
      }
      mutated = original.replace(fixture.marker, fixture.replacement);
    }
    if (mutated === original) {
      failures.push(`${fixture.name}: mutation did not change ${fixture.path}`);
      continue;
    }
    writeFileSync(target, mutated);
    const result = spawnSync(process.execPath, [verifier], { cwd: root, encoding: 'utf8' });
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    if (result.status === 0) failures.push(`${fixture.name}: verifier unexpectedly passed`);
    else if (!fixture.diagnostic.test(output)) {
      failures.push(`${fixture.name}: wrong diagnostic: ${output.slice(-1200)}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (failures.length > 0) {
  console.error('[test:v3-stopless-resource-control-red-fixtures] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`[test:v3-stopless-resource-control-red-fixtures] ok (${cases.length} forbidden mutations rejected)`);
