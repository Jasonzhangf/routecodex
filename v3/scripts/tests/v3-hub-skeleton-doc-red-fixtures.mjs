#!/usr/bin/env node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const verifier = resolve(repoRoot, 'v3/scripts/architecture/verify-v3-architecture-docs.mjs');
const files = [
  'docs/architecture/v3-resource-operation-map.yml',
  'docs/architecture/v3-function-map.yml',
  'docs/architecture/v3-mainline-call-map.yml',
  'docs/architecture/v3-verification-map.yml',
];
const originals = new Map(files.map((file) => [file, readFileSync(join(repoRoot, file), 'utf8')]));
const fixtures = [
  {
    name: 'bound Hub edge removed',
    file: 'docs/architecture/v3-mainline-call-map.yml',
    from: 'step_id: v3-hub-req-01\n    from_node: V3HubReqInbound01ClientRaw\n    to_node: V3HubReqInbound02Normalized',
    to: 'step_id: v3-hub-req-01\n    from_node: V3HubReqInbound01ClientRaw\n    to_node: V3HubReqInbound02Normalized_REMOVED',
    diagnostic: /v3-hub-req-01 must remain adjacent/,
  },
  {
    name: 'relay D worker function map removed',
    file: 'docs/architecture/v3-function-map.yml',
    from: 'feature_id: v3.hub_relay_gate_review_surface',
    to: 'feature_id: v3.hub_relay_gate_review_surface_REMOVED',
    diagnostic: /function map missing v3\.hub_relay_gate_review_surface/,
  },
  {
    name: 'relay request mainline reverse binding removed',
    file: 'docs/architecture/v3-function-map.yml',
    from: '  - v3-hub-relay-req-03',
    to: '  - v3-hub-relay-req-03_REMOVED',
    diagnostic: /binds missing mainline step v3-hub-relay-req-03_REMOVED/,
  },
  {
    name: 'op-runner req-06 attempt_projection_context dependency removed',
    file: 'docs/architecture/v3-mainline-call-map.yml',
    from: '      consumes: [v3.request.provider_semantic, v3.operation_runner.attempt_projection_context]',
    to: '      consumes: [v3.request.provider_semantic]',
    diagnostic: /v3-op-runner-req-06 resource_flow\.consumes must declare v3\.operation_runner\.attempt_projection_context/,
  },
  {
    name: 'attempt_projection_context orphan_tool_output_literals reader removed',
    file: 'docs/architecture/v3-resource-operation-map.yml',
    from: 'allowed_readers: [adjust_provider_private_request, build_provider_req_compat_06_from_v3_hub_req_outbound_07, normalize_v3_operation_runner_provider_response, inverse_project_v3_operation_runner_client_response]',
    to: 'allowed_readers: [normalize_v3_operation_runner_provider_response, inverse_project_v3_operation_runner_client_response]',
    diagnostic: /attempt_projection_context allowed_readers missing adjust_provider_private_request/,
  },
  {
    name: 'op-runner req-04 explicit_history_pairing write removed',
    file: 'docs/architecture/v3-mainline-call-map.yml',
    from: '      produces: [v3.operation_runner.tool_thinking_turn_context, v3.operation_runner.explicit_history_pairing]',
    to: '      produces: [v3.operation_runner.tool_thinking_turn_context]',
    diagnostic: /v3-op-runner-req-04 resource_flow\.produces must declare v3\.operation_runner\.explicit_history_pairing/,
  },
  {
    name: 'op-runner req-05 explicit_history_pairing read removed',
    file: 'docs/architecture/v3-mainline-call-map.yml',
    from: '      consumes: [v3.request.normal_payload, v3.operation_runner.request_inverse_context, v3.operation_runner.explicit_history_pairing]',
    to: '      consumes: [v3.request.normal_payload, v3.operation_runner.request_inverse_context]',
    diagnostic: /v3-op-runner-req-05 resource_flow\.consumes must declare v3\.operation_runner\.explicit_history_pairing/,
  },
  {
    name: 'explicit_history_pairing req04 writer removed',
    file: 'docs/architecture/v3-resource-operation-map.yml',
    from: 'allowed_writers: [normalize_v3_operation_runner_request_losslessly, govern_v3_operation_runner_chat_request, govern_chat_request_at_req04, execute_v3_responses_direct_runtime_kernel_core_resident, execute_v3_responses_direct_runtime_kernel, responses_direct_route_hook]',
    to: 'allowed_writers: [normalize_v3_operation_runner_request_losslessly, execute_v3_responses_direct_runtime_kernel_core_resident, execute_v3_responses_direct_runtime_kernel, responses_direct_route_hook]',
    diagnostic: /explicit_history_pairing allowed_writers missing govern_v3_operation_runner_chat_request/,
  },
  {
    name: 'explicit_history_pairing direct kernel writer removed',
    file: 'docs/architecture/v3-resource-operation-map.yml',
    from: 'allowed_writers: [normalize_v3_operation_runner_request_losslessly, govern_v3_operation_runner_chat_request, govern_chat_request_at_req04, execute_v3_responses_direct_runtime_kernel_core_resident, execute_v3_responses_direct_runtime_kernel, responses_direct_route_hook]',
    to: 'allowed_writers: [normalize_v3_operation_runner_request_losslessly, govern_v3_operation_runner_chat_request, govern_chat_request_at_req04]',
    diagnostic: /explicit_history_pairing allowed_writers missing execute_v3_responses_direct_runtime_kernel_core_resident/,
  },
  {
    name: 'explicit_history_pairing req-outbound-07 reader removed',
    file: 'docs/architecture/v3-resource-operation-map.yml',
    from: 'allowed_readers: [govern_v3_operation_runner_chat_request, project_v3_operation_runner_standard_provider_request, build_v3_hub_req_outbound_07_from_v3_hub_req_target_06, govern_v3_operation_runner_chat_response, execute_v3_responses_direct_runtime_kernel_core_resident, responses_direct_route_hook, responses_direct_request_projection_hook, responses_direct_request_projection_hook_with_key_catalog_and_drop_context]',
    to: 'allowed_readers: [govern_v3_operation_runner_chat_request, govern_v3_operation_runner_chat_response, execute_v3_responses_direct_runtime_kernel_core_resident, responses_direct_route_hook, responses_direct_request_projection_hook, responses_direct_request_projection_hook_with_key_catalog_and_drop_context]',
    diagnostic: /explicit_history_pairing allowed_readers missing project_v3_operation_runner_standard_provider_request/,
  },
  {
    name: 'explicit_history_pairing direct projection reader removed',
    file: 'docs/architecture/v3-resource-operation-map.yml',
    from: 'allowed_readers: [govern_v3_operation_runner_chat_request, project_v3_operation_runner_standard_provider_request, build_v3_hub_req_outbound_07_from_v3_hub_req_target_06, govern_v3_operation_runner_chat_response, execute_v3_responses_direct_runtime_kernel_core_resident, responses_direct_route_hook, responses_direct_request_projection_hook, responses_direct_request_projection_hook_with_key_catalog_and_drop_context]',
    to: 'allowed_readers: [govern_v3_operation_runner_chat_request, project_v3_operation_runner_standard_provider_request, build_v3_hub_req_outbound_07_from_v3_hub_req_target_06, govern_v3_operation_runner_chat_response]',
    diagnostic: /explicit_history_pairing allowed_readers missing responses_direct_request_projection_hook/,
  },
  {
    name: 'hub-relay-req-02 explicit_history_pairing consumes read removed',
    file: 'docs/architecture/v3-mainline-call-map.yml',
    from: '  - step_id: v3-hub-relay-req-02\n    from_node: V3HubReqInbound02Normalized\n    to_node: V3HubReqChatProcess04Governed\n    caller_symbol: V3HubRelayRequestHooks::run_from_normalized_with_events\n    caller_file: v3/crates/routecodex-v3-runtime/src/hub_v1/relay_request.rs\n    callee_symbol: build_v3_hub_req_chat_process_04_from_v3_hub_req_inbound_02\n    callee_file: v3/crates/routecodex-v3-runtime/src/hub_v1/req_chat_process_04_governed.rs\n    status: anchored\n    binding_kind: relay_request_source_slice\n    owner_feature_id: v3.hub_relay_request_semantics\n    resource_flow:\n      consumes:\n      - v3.request.normal_payload\n      - v3.hub.entry_protocol\n      - v3.operation_runner.explicit_history_pairing',
    to: '  - step_id: v3-hub-relay-req-02\n    from_node: V3HubReqInbound02Normalized\n    to_node: V3HubReqChatProcess04Governed\n    caller_symbol: V3HubRelayRequestHooks::run_from_normalized_with_events\n    caller_file: v3/crates/routecodex-v3-runtime/src/hub_v1/relay_request.rs\n    callee_symbol: build_v3_hub_req_chat_process_04_from_v3_hub_req_inbound_02\n    callee_file: v3/crates/routecodex-v3-runtime/src/hub_v1/req_chat_process_04_governed.rs\n    status: anchored\n    binding_kind: relay_request_source_slice\n    owner_feature_id: v3.hub_relay_request_semantics\n    resource_flow:\n      consumes:\n      - v3.request.normal_payload\n      - v3.hub.entry_protocol',
    diagnostic: /v3-hub-relay-req-02 resource_flow\.consumes must declare v3\.operation_runner\.explicit_history_pairing/,
  },
  {
    name: 'hub-relay-req-02 explicit_history_pairing produces write removed',
    file: 'docs/architecture/v3-mainline-call-map.yml',
    from: '      produces:\n      - v3.request.normal_payload\n      - v3.operation_runner.explicit_history_pairing\n      side_channel_reads:\n      - v3.hub.entry_protocol\n      - v3.operation_runner.explicit_history_pairing',
    to: '      produces:\n      - v3.request.normal_payload\n      side_channel_reads:\n      - v3.hub.entry_protocol\n      - v3.operation_runner.explicit_history_pairing',
    diagnostic: /v3-hub-relay-req-02 resource_flow\.produces must declare v3\.operation_runner\.explicit_history_pairing/,
  },
  {
    name: 'hub-relay-req-02 explicit_history_pairing side_channel_reads removed',
    file: 'docs/architecture/v3-mainline-call-map.yml',
    from: '      side_channel_reads:\n      - v3.hub.entry_protocol\n      - v3.operation_runner.explicit_history_pairing\n      side_channel_writes:\n      - v3.operation_runner.explicit_history_pairing',
    to: '      side_channel_reads:\n      - v3.hub.entry_protocol\n      side_channel_writes:\n      - v3.operation_runner.explicit_history_pairing',
    diagnostic: /v3-hub-relay-req-02 resource_flow\.side_channel_reads must declare v3\.operation_runner\.explicit_history_pairing/,
  },
  {
    name: 'hub-relay-req-02 explicit_history_pairing side_channel_writes removed',
    file: 'docs/architecture/v3-mainline-call-map.yml',
    from: '      side_channel_reads:\n      - v3.hub.entry_protocol\n      - v3.operation_runner.explicit_history_pairing\n      side_channel_writes:\n      - v3.operation_runner.explicit_history_pairing',
    to: '      side_channel_reads:\n      - v3.hub.entry_protocol\n      - v3.operation_runner.explicit_history_pairing\n      side_channel_writes: []',
    diagnostic: /v3-hub-relay-req-02 resource_flow\.side_channel_writes must declare v3\.operation_runner\.explicit_history_pairing/,
  },
  {
    name: 'rd-09-direct-policy explicit_history_pairing consumes read removed',
    file: 'docs/architecture/v3-mainline-call-map.yml',
    from: '  - step_id: v3-rd-09-direct-policy\n    from_node: V3Execution11ProtocolDecision\n    to_node: V3ResponsesDirect11Policy\n    caller_symbol: execute_v3_responses_direct_runtime_kernel\n    caller_file: v3/crates/routecodex-v3-runtime/src/kernel.rs\n    callee_symbol: responses_direct_route_hook\n    callee_file: v3/crates/routecodex-v3-runtime/src/hooks.rs\n    status: anchored\n    owner_feature_id: v3.responses_direct_mvp_architecture\n    resource_flow:\n      consumes:\n      - v3.execution.protocol_decision\n      - v3.target.concrete_provider\n      - v3.request.normal_payload\n      - v3.request.protocol_fields\n      - v3.operation_runner.explicit_history_pairing',
    to: '  - step_id: v3-rd-09-direct-policy\n    from_node: V3Execution11ProtocolDecision\n    to_node: V3ResponsesDirect11Policy\n    caller_symbol: execute_v3_responses_direct_runtime_kernel\n    caller_file: v3/crates/routecodex-v3-runtime/src/kernel.rs\n    callee_symbol: responses_direct_route_hook\n    callee_file: v3/crates/routecodex-v3-runtime/src/hooks.rs\n    status: anchored\n    owner_feature_id: v3.responses_direct_mvp_architecture\n    resource_flow:\n      consumes:\n      - v3.execution.protocol_decision\n      - v3.target.concrete_provider\n      - v3.request.normal_payload\n      - v3.request.protocol_fields',
    diagnostic: /v3-rd-09-direct-policy resource_flow\.consumes must declare v3\.operation_runner\.explicit_history_pairing/,
  },
  {
    name: 'rd-09-direct-policy explicit_history_pairing produces write removed',
    file: 'docs/architecture/v3-mainline-call-map.yml',
    from: '      produces:\n      - v3.responses_direct.policy\n      - v3.operation_runner.explicit_history_pairing\n      side_channel_reads:\n      - v3.execution.protocol_decision\n      - v3.target.concrete_provider\n      - v3.request.protocol_fields\n      - v3.operation_runner.explicit_history_pairing',
    to: '      produces:\n      - v3.responses_direct.policy\n      side_channel_reads:\n      - v3.execution.protocol_decision\n      - v3.target.concrete_provider\n      - v3.request.protocol_fields\n      - v3.operation_runner.explicit_history_pairing',
    diagnostic: /v3-rd-09-direct-policy resource_flow\.produces must declare v3\.operation_runner\.explicit_history_pairing/,
  },
  {
    name: 'rd-09-direct-policy explicit_history_pairing side_channel_reads removed',
    file: 'docs/architecture/v3-mainline-call-map.yml',
    from: '      side_channel_reads:\n      - v3.execution.protocol_decision\n      - v3.target.concrete_provider\n      - v3.request.protocol_fields\n      - v3.operation_runner.explicit_history_pairing\n      side_channel_writes:\n      - v3.responses_direct.policy\n      - v3.request.tool_thinking_turn_context\n      - v3.operation_runner.explicit_history_pairing',
    to: '      side_channel_reads:\n      - v3.execution.protocol_decision\n      - v3.target.concrete_provider\n      - v3.request.protocol_fields\n      side_channel_writes:\n      - v3.responses_direct.policy\n      - v3.request.tool_thinking_turn_context\n      - v3.operation_runner.explicit_history_pairing',
    diagnostic: /v3-rd-09-direct-policy resource_flow\.side_channel_reads must declare v3\.operation_runner\.explicit_history_pairing/,
  },
  {
    name: 'rd-09-direct-policy explicit_history_pairing side_channel_writes removed',
    file: 'docs/architecture/v3-mainline-call-map.yml',
    from: '      side_channel_writes:\n      - v3.responses_direct.policy\n      - v3.request.tool_thinking_turn_context\n      - v3.operation_runner.explicit_history_pairing',
    to: '      side_channel_writes:\n      - v3.responses_direct.policy\n      - v3.request.tool_thinking_turn_context',
    diagnostic: /v3-rd-09-direct-policy resource_flow\.side_channel_writes must declare v3\.operation_runner\.explicit_history_pairing/,
  },
  {
    name: 'rd-10 explicit_history_pairing consumes read removed',
    file: 'docs/architecture/v3-mainline-call-map.yml',
    from: '  - step_id: v3-rd-10\n    from_node: V3ResponsesDirect11Policy\n    to_node: V3Provider12ResponsesWirePayload\n    caller_symbol: responses_direct_request_projection_hook\n    caller_file: v3/crates/routecodex-v3-runtime/src/hooks.rs\n    callee_symbol: build_v3_provider_12_responses_wire_payload\n    callee_file: v3/crates/routecodex-v3-provider-responses/src/wire.rs\n    status: anchored\n    owner_feature_id: v3.responses_provider_runtime\n    resource_flow:\n      consumes:\n      - v3.responses_direct.policy\n      - v3.request.normal_payload\n      - v3.target.concrete_provider\n      - v3.operation_runner.explicit_history_pairing',
    to: '  - step_id: v3-rd-10\n    from_node: V3ResponsesDirect11Policy\n    to_node: V3Provider12ResponsesWirePayload\n    caller_symbol: responses_direct_request_projection_hook\n    caller_file: v3/crates/routecodex-v3-runtime/src/hooks.rs\n    callee_symbol: build_v3_provider_12_responses_wire_payload\n    callee_file: v3/crates/routecodex-v3-provider-responses/src/wire.rs\n    status: anchored\n    owner_feature_id: v3.responses_provider_runtime\n    resource_flow:\n      consumes:\n      - v3.responses_direct.policy\n      - v3.request.normal_payload\n      - v3.target.concrete_provider',
    diagnostic: /v3-rd-10 resource_flow\.consumes must declare v3\.operation_runner\.explicit_history_pairing/,
  },
  {
    name: 'rd-10 explicit_history_pairing side_channel_reads removed',
    file: 'docs/architecture/v3-mainline-call-map.yml',
    from: '      side_channel_reads:\n      - v3.responses_direct.policy\n      - v3.target.concrete_provider\n      - v3.operation_runner.explicit_history_pairing',
    to: '      side_channel_reads:\n      - v3.responses_direct.policy\n      - v3.target.concrete_provider',
    diagnostic: /v3-rd-10 resource_flow\.side_channel_reads must declare v3\.operation_runner\.explicit_history_pairing/,
  },
];
const root = mkdtempSync(join(tmpdir(), 'routecodex-v3-hub-data-red-'));
const failures = [];
const run = () => spawnSync(process.execPath, [verifier], {
  cwd: root, encoding: 'utf8', env: { ...process.env, ROUTECODEX_V3_SOURCE_ROOT: root },
});
try {
  for (const [file, source] of originals) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), source);
  }
  const baseline = run();
  if (baseline.status !== 0) throw new Error(`baseline failed: ${baseline.stdout}\n${baseline.stderr}`);
  for (const fixture of fixtures) {
    const source = originals.get(fixture.file);
    if (!source.includes(fixture.from)) throw new Error(`${fixture.name}: mutation input missing`);
    writeFileSync(join(root, fixture.file), source.replace(fixture.from, fixture.to));
    const result = run();
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    if (result.status !== 1 || !fixture.diagnostic.test(output)) {
      failures.push(`${fixture.name}: wrong exit/diagnostic (${result.status}): ${output.slice(-800)}`);
    }
    writeFileSync(join(root, fixture.file), source);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
if (failures.length) {
  console.error('[test:v3-hub-skeleton-doc-red-fixtures] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(`[test:v3-hub-skeleton-doc-red-fixtures] ok (${fixtures.length} data mutations rejected)`);
