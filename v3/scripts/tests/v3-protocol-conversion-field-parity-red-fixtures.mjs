#!/usr/bin/env node
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const verifier = resolve(repo, 'v3/scripts/architecture/verify-v3-protocol-conversion-field-parity.mjs');
const matrix = 'docs/architecture/reviews/v3-protocol-semantic-field-matrix.yml';
const profiles = 'docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml';
const files = [
  matrix, profiles,
  'docs/architecture/manifests/v3.protocol_request_field_projection.yml',
  'docs/architecture/manifests/v3.protocol_request_field_projection.modules.yml',
  'docs/architecture/v3-function-map.yml',
  'docs/architecture/v3-mainline-call-map.yml',
  'docs/architecture/v3-verification-map.yml',
  'v3/crates/routecodex-v3-runtime/tables/request_field_map.json',
  'v3/crates/routecodex-v3-runtime/tables/finish_reason_map.json',
];

// Retained data counterexamples. Rust spelling, package commands, HTML bytes,
// hashes and repeated examples of the same data failure are retired.
const cases = [
  {
    name: 'Anthropic content union loses its scalar semantic mapping', file: matrix,
    from: '        anthropic:\n          - request.messages\n          - request.messages[].content\n        gemini:\n',
    to: '        anthropic:\n          - request.messages\n        gemini:\n',
    diagnostic: /source field anthropic\.request\.messages\[\]\.content mapped to superset 0 times/u,
  },
  {
    name: 'Anthropic hosted tool id branch loses its target semantic', file: profiles,
    from: 'semantic_id: request.messages_items.content_items.server_tool_use.id',
    to: 'semantic_id: request.messages_items.content_items.server_tool_use.id_removed',
    diagnostic: /source field anthropic\.request\.messages\[\]\.content\[\]\.id mapped to superset 2 times/u,
  },
  {
    name: 'Anthropic hosted tool id branch overlaps ordinary tool use', file: profiles,
    from: 'semantic_id: request.messages_items.content_items.server_tool_use.id\n          operator: routecodex.v3.field.array_container_shape@1\n          predicates:\n            - path: request.messages[].content[].type\n              value: server_tool_use',
    to: 'semantic_id: request.messages_items.content_items.server_tool_use.id\n          operator: routecodex.v3.field.array_container_shape@1\n          predicates:\n            - path: request.messages[].content[].type\n              value: tool_use',
    diagnostic: /source field anthropic\.request\.messages\[\]\.content\[\]\.id mapped to superset 2 times/u,
  },
  {
    name: 'Canonical extension registry omits an extension field', file: matrix,
    from: '  - field: request.reasoning_summary_policy\n    semantic_id: request.reasoning_summary_policy\n',
    to: '  - field: request.reasoning_summary_policy_removed\n    semantic_id: request.reasoning_summary_policy_removed\n',
    diagnostic: /canonical_extension_registry|request\.reasoning_summary_policy/u,
  },
  {
    name: 'OpenAI Chat reasoning summary compatibility contract regresses to unmapped',
    file: 'docs/architecture/manifests/v3.protocol_request_field_projection.yml',
    from: 'openai_chat: compatible_reasoning_effort_auto_medium_concise_low_detailed_high_merge_higher', to: 'openai_chat: unmapped',
    diagnostic: /compatible_reasoning_effort/u,
  },
  {
    name: 'Extended Chat renames native OpenAI Chat field', file: matrix,
    from: '    - extended_openai_chat_field: request.messages[].role\n      semantic_id: request.messages[].role\n',
    to: '    - extended_openai_chat_field: request.messages.role\n      semantic_id: request.messages[].role\n',
    diagnostic: /OpenAI Chat native field must not be renamed|request\.messages\.role/u,
  },
  {
    name: 'Manual semantic translation group for tool arguments is renamed away', file: matrix,
    from: '  - group_id: tool.call.arguments\n    standard_chat_field: request.messages[].tool_calls[].function.arguments\n',
    to: '  - group_id: tool.call.arguments_removed\n    standard_chat_field: request.messages[].tool_calls[].function.arguments\n',
    diagnostic: /missing manual semantic translation group tool\.call\.arguments/u,
  },
  {
    name: 'Tool call and result id discriminator branches overlap', file: matrix,
    from: '        - direction: request\n          source_path: request.input[].call_id\n          provenance: request_inverse_context.responses_input_item_type\n          predicates:\n            - path: request.input[].type\n              value: function_call_output\n',
    to: '        - direction: request\n          source_path: request.input[].call_id\n          provenance: request_inverse_context.responses_input_item_type\n          predicates:\n            - path: request.input[].type\n              value: function_call\n',
    diagnostic: /source field responses\.request\.input\[\]\.call_id mapped to superset 2 times/u,
  },
  {
    name: 'Shape branch contract drops negative cases', file: matrix,
    from: '    shape_branch_cases:\n      positive:\n        - protocol: responses\n',
    to: '    shape_branch_cases_removed:\n      positive:\n        - protocol: responses\n',
    diagnostic: /content\.image_url|shape_branch_cases\.negative|must not be empty|missing anthropic branch/u,
  },
  {
    name: 'Gemini allowedFunctionNames collapses into native tool_choice', file: matrix,
    from: '        gemini:\n          - request.toolConfig.functionCallingConfig.mode\n      source_classification: canonical_chat_fields\n',
    to: '        gemini:\n          - request.toolConfig.functionCallingConfig.mode\n          - request.toolConfig.functionCallingConfig.allowedFunctionNames\n      source_classification: canonical_chat_fields\n',
    diagnostic: /request\.tool_choice.*allowedFunctionNames|source field gemini\.request\.toolConfig\.functionCallingConfig\.allowedFunctionNames mapped to superset/u,
  },
  {
    name: 'Gemini thinkingConfig budget extension row removed', file: matrix,
    from: '    - extended_openai_chat_field: request.reasoning_budget_tokens\n      semantic_id: request.reasoning_budget_tokens\n',
    to: '    - extended_openai_chat_field: request.reasoning_budget_removed\n      semantic_id: request.reasoning_budget_removed\n',
    diagnostic: /request\.reasoning_budget_tokens|thinkingBudget/u,
  },
  {
    name: 'Gemini topP collapses into temperature superset row', file: matrix,
    from: '    - extended_openai_chat_field: request.temperature\n      semantic_id: request.temperature\n      direction: request\n      mapping_status: mapped\n      semantic_owner: chat.canonical_semantics\n      current_impl: covered\n      gap: none\n      equivalent_fields:\n        responses:\n          - request.temperature\n        openai_chat:\n          - request.temperature\n        anthropic:\n          - request.temperature\n        gemini:\n          - request.generationConfig.temperature\n',
    to: '    - extended_openai_chat_field: request.temperature\n      semantic_id: request.temperature\n      direction: request\n      mapping_status: mapped\n      semantic_owner: chat.canonical_semantics\n      current_impl: covered\n      gap: none\n      equivalent_fields:\n        responses:\n          - request.temperature\n        openai_chat:\n          - request.temperature\n        anthropic:\n          - request.temperature\n        gemini:\n          - request.generationConfig.temperature\n          - request.generationConfig.topP\n',
    diagnostic: /request\.temperature.*topP|must not collapse Gemini request\.generationConfig\.topP|source field gemini\.request\.generationConfig\.topP mapped to superset/u,
  },
  {
    name: 'Manual audit statuses regress to pending_audit', file: matrix,
    from: '      current_impl: extension_declared\n      gap: runtime mapping partial or extension-only gap\n',
    to: '      current_impl: pending_audit\n      gap: runtime mapping partial or extension-only gap\n',
    diagnostic: /pending_audit|precise audited statuses/u,
  },
  {
    name: 'Audit truth status count drifts from matrix', file: matrix,
    from: '    extension_declared: 227\n', to: '    extension_declared: 226\n',
    diagnostic: /audited_status_counts\.extension_declared|must equal current_impl count/u,
  },
  {
    name: 'Gap audit drops runtime extension closeout row', file: matrix,
    from: '    - gap_id: gap.runtime_extension_declared\n      category: runtime_closeout\n',
    to: '    - gap_id: gap.runtime_extension_declared_removed\n      category: runtime_closeout\n',
    diagnostic: /gap\.runtime_extension_declared|gap_audit/u,
  },
  {
    name: 'Implementation gap omits closeout status', file: matrix,
    from: '    closeout_status: needs_runtime_goal\n    required_gate: npm run test:v3-protocol-conversion-field-parity\n  - id: gap.openai_chat.long_tail_fields\n',
    to: '    required_gate: npm run test:v3-protocol-conversion-field-parity\n  - id: gap.openai_chat.long_tail_fields\n',
    diagnostic: /implementation_gaps\.gap\.gemini\.field_coverage|closeout_status/u,
  },
  {
    name: 'Extended OpenAI Chat superset assigns business field to MetadataCenter', file: matrix,
    from: '      semantic_owner: chat.extension_semantics\n      current_impl: extension_declared\n',
    to: '      semantic_owner: MetadataCenter\n      current_impl: extension_declared\n',
    diagnostic: /MetadataCenter|business semantic owner/u,
  },
  {
    name: 'Full protocol matrix drops Gemini toolConfig field', file: matrix,
    from: '      - field: toolConfig\n        semantic: tool.choice\n        chat_extension: canonical_chat\n        current_impl: partial\n', to: '',
    diagnostic: /toolConfig|field-matrix|gemini/u,
  },
  {
    name: 'Source inventory drops OpenAI Chat audio field', file: matrix,
    from: '      - request.audio.format\n', to: '', diagnostic: /source_inventory|audio\.format|openai_chat/u,
  },
  {
    name: 'Semantic correspondence drops Gemini thinking budget mapping', file: matrix,
    from: '  reasoning.request_budget_tokens:\n    canonical_path: chat.reasoning_budget_tokens\n    chat_extension: request.reasoning_budget_tokens\n    current_impl: partial\n',
    to: '  reasoning.request_budget_tokens_removed:\n    canonical_path: chat.reasoning_budget_tokens\n    chat_extension: request.reasoning_budget_tokens\n    current_impl: partial\n',
    diagnostic: /semantic_correspondence|thinkingConfig\.thinkingBudget|reasoning\.request_budget_tokens/u,
  },
  {
    name: 'Protocol parity incorrectly claims MetadataCenter owner', file: 'docs/architecture/v3-function-map.yml',
    from: '  - v3/crates/routecodex-v3-runtime/tests/responses_relay_field_parity_integration.rs\n  - v3/crates/routecodex-v3-runtime/tests/responses_direct_tool_passthrough.rs',
    to: '  - v3/crates/routecodex-v3-runtime/tests/responses_relay_field_parity_integration.rs\n  - MetadataCenter\n  - v3/crates/routecodex-v3-runtime/tests/responses_direct_tool_passthrough.rs',
    diagnostic: /MetadataCenter|metadata_center/u,
  },
  {
    name: 'Direct production parity test missing from verification map', file: 'docs/architecture/v3-verification-map.yml',
    from: '  - responses_openai_chat_field_parity_direct_kernel_preserves_responses_input_include_and_tool_history',
    to: '  - direct_kernel_parity_removed', diagnostic: /required_blackbox/u,
  },
  {
    name: 'Direct production parity test missing from function map', file: 'docs/architecture/v3-function-map.yml',
    from: '  - responses_openai_chat_field_parity_direct_kernel_preserves_responses_input_include_and_tool_history',
    to: '  - direct_kernel_test_binding_removed', diagnostic: /responses_openai_chat_field_parity_direct_kernel_preserves_responses_input_include_and_tool_history/u,
  },
  {
    name: 'Direct production parity duplicates Direct mainline edge', file: 'docs/architecture/v3-mainline-call-map.yml',
    from: '  - step_id: v3-protocol-field-parity-openai-chat-same-protocol-01',
    to: '  - step_id: v3-protocol-field-parity-responses-direct-wire-01', diagnostic: /duplicate Direct parity edge/u,
  },
  {
    name: 'Existing Direct provider wire edge owner drifts', file: 'docs/architecture/v3-mainline-call-map.yml',
    from: '    owner_feature_id: v3.responses_provider_runtime\n    resource_flow:\n      consumes:\n      - v3.responses_direct.policy',
    to: '    owner_feature_id: v3.protocol_conversion_field_parity\n    resource_flow:\n      consumes:\n      - v3.responses_direct.policy',
    diagnostic: /v3-rd-10 owner_feature_id must be v3\.responses_provider_runtime/u,
  },
  {
    name: 'Malformed arguments mainline edge moves away from adjacent field projector', file: 'docs/architecture/v3-mainline-call-map.yml',
    from: 'caller_symbol: build_v3_openai_chat_assistant_tool_call_message\n    caller_file: v3/crates/routecodex-v3-runtime/src/hub_v1/responses_openai_codec.rs\n    callee_symbol: project_v3_responses_tool_call_to_openai_chat',
    to: 'caller_symbol: responses_openai_chat_field_parity_unpaired_malformed_arguments_preserve_exact_string_without_reselect\n    caller_file: v3/crates/routecodex-v3-runtime/tests/responses_relay_field_parity_integration.rs\n    callee_symbol: project_v3_responses_tool_call_to_openai_chat',
    diagnostic: /malformed-arguments runtime edge caller_symbol/u,
  },
  {
    name: 'Provider compat failure no longer enters typed Error05', file: 'docs/architecture/v3-mainline-call-map.yml',
    from: 'step_id: v3-provider-action-gate-01\n      from_node: ProviderReqCompat06ProviderCompat\n      to_node: V3Error05ExecutionDecision',
    to: 'step_id: v3-provider-action-gate-01\n      from_node: ProviderReqCompat06ProviderCompat\n      to_node: V3ProviderReqOutbound09TransportRequest',
    diagnostic: /ProviderReqCompat06 typed failure edge/u,
  },
  {
    name: 'OpenAI Chat outbound drops same-protocol web search field', file: 'v3/crates/routecodex-v3-runtime/tables/request_field_map.json',
    from: '   "web_search_options",', to: '   "web_search_disabled",', diagnostic: /web_search_options/u,
  },
  {
    name: 'Relay Responses outbound forwards continuation owner field', file: 'v3/crates/routecodex-v3-runtime/tables/request_field_map.json',
    from: '   "moderation",\n   "client_metadata",\n   "reasoning_effort",',
    to: '   "moderation",\n   "client_metadata",\n   "previous_response_id",\n   "reasoning_effort",', diagnostic: /previous_response_id/u,
  },
  {
    name: 'Outbound projection contract loses typed control provenance', file: matrix,
    from: '  control_provenance: typed_owner_not_business_key_spelling',
    to: '  control_provenance: business_key_spelling',
    diagnostic: /typed owner provenance/u,
  },
  {
    name: 'Anthropic refusal finish-reason registry loses content_filter identity', file: 'v3/crates/routecodex-v3-runtime/tables/finish_reason_map.json',
    from: '{ "hub": "content_filter", "responses": "content_filter", "openai_chat": "content_filter", "anthropic": "refusal" }',
    to: '{ "hub": "stop", "responses": "end_turn", "openai_chat": "stop", "anthropic": "refusal" }', diagnostic: /missing registered refusal/u,
  },
  {
    name: 'Protocol matrix drops a registered Chat message field', file: matrix,
    from: 'request.messages[].role', to: 'request.messages[].role_removed', diagnostic: /canonical_chat_semantics|request\.messages\[\]\.role/u,
  },
];

function run(root) {
  return spawnSync(process.execPath, [verifier], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, ROUTECODEX_V3_SOURCE_ROOT: root },
  });
}
const baseline = run(repo);
if (baseline.status !== 0) {
  console.error('[test:v3-protocol-conversion-field-parity-red-fixtures] baseline failed');
  console.error(`${baseline.stdout ?? ''}\n${baseline.stderr ?? ''}`);
  process.exit(1);
}
const failures = [];
for (const test of cases) {
  const root = mkdtempSync(join(tmpdir(), 'v3-parity-data-red-'));
  try {
    for (const file of files) {
      const target = resolve(root, file);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(resolve(repo, file), target);
    }
    const target = resolve(root, test.file);
    const source = readFileSync(target, 'utf8');
    if (!source.includes(test.from)) { failures.push(`${test.name}: mutation source missing`); continue; }
    writeFileSync(target, source.replace(test.from, test.to));
    const result = run(root);
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    if (result.status === 0) failures.push(`${test.name}: verifier unexpectedly passed`);
    else if (!test.diagnostic.test(output)) failures.push(`${test.name}: wrong diagnostic: ${output.slice(-1000)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
if (failures.length) {
  console.error('[test:v3-protocol-conversion-field-parity-red-fixtures] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(`[test:v3-protocol-conversion-field-parity-red-fixtures] ok (${cases.length} data mutations rejected)`);
