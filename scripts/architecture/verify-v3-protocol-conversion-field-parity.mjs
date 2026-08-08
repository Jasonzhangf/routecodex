#!/usr/bin/env node
import { readFileSync } from 'node:fs';import YAML from 'yaml';
import {
  renderV3ProtocolSemanticFieldMatrix,
  renderV3ProtocolSemanticFieldMatrixHtml,
  V3_PROTOCOL_SEMANTIC_FIELD_MATRIX_HTML_PATH,
  V3_PROTOCOL_SEMANTIC_FIELD_MATRIX_PATH,
} from './render-v3-protocol-semantic-field-matrix.mjs';

const paths = {
  design: 'docs/goals/v3-protocol-conversion-field-parity-test-design.md',
  requestFieldProjectionDesign: 'docs/design/v3-protocol-request-field-projection.md',
  requestFieldProjectionManifest: 'docs/architecture/manifests/v3.protocol_request_field_projection.yml',
  requestFieldProjectionModules: 'docs/architecture/manifests/v3.protocol_request_field_projection.modules.yml',
  gapCloseoutPlan: 'docs/goals/v3-protocol-semantic-field-gap-closeout-plan.md',
  hub: 'v3/crates/routecodex-v3-runtime/src/hub_v1.rs',
  hubTests: 'v3/crates/routecodex-v3-runtime/src/hub_v1/tests.rs',
  reqInbound02: 'v3/crates/routecodex-v3-runtime/src/hub_v1/req_inbound_02_normalized.rs',
  responsesOpenaiCodec: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_openai_codec.rs',
  clientMetadataProjection: 'v3/crates/routecodex-v3-runtime/src/hub_v1/client_metadata_projection.rs',
  requestOutboundFormat: 'v3/crates/routecodex-v3-runtime/src/hub_v1/request_outbound_format.rs',
  requestOutboundToolProjection: 'v3/crates/routecodex-v3-runtime/src/hub_v1/request_outbound_builtin_tool_projection.rs',
  requestOutboundMetadata: 'v3/crates/routecodex-v3-runtime/src/hub_v1/request_outbound_metadata.rs',
  requestOutboundFormatExtraTests: 'v3/crates/routecodex-v3-runtime/src/hub_v1/request_outbound_format_extra_tests.rs',
  providerReqCompat: 'v3/crates/routecodex-v3-runtime/src/hub_v1/provider_req_compat_06_provider_compat.rs',
  directPassthroughTests: 'v3/crates/routecodex-v3-runtime/tests/responses_direct_tool_passthrough.rs',
  responsesRuntime: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs',
  anthropicCodec: 'v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_codec.rs',
  anthropicProjectionContext: 'v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_codec/projection_context.rs',
  anthropicCodecToolProjection: 'v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_codec_tool_projection.rs',
  responsesToAnthropicCodec: 'v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_codec/responses_to_anthropic.rs',
  anthropicRequestFieldProjection: 'v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_request_field_projection.rs',
  anthropicProjection: 'v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime_codec.rs',
  geminiCodec: 'v3/crates/routecodex-v3-runtime/src/hub_v1/gemini_codec.rs',
  responsesTests: 'v3/crates/routecodex-v3-runtime/tests/responses_relay_local_continuation_integration.rs',
  responsesAnthropicProviderTests: 'v3/crates/routecodex-v3-runtime/tests/responses_relay_anthropic_provider_wire_integration.rs',
  anthropicTests: 'v3/crates/routecodex-v3-runtime/tests/anthropic_relay_runtime_integration.rs',
  anthropicCodecTests: 'v3/crates/routecodex-v3-runtime/tests/hub_anthropic_codec_characterization.rs',
  openaiTests: 'v3/crates/routecodex-v3-runtime/tests/openai_chat_relay_runtime_integration.rs',
  geminiTests: 'v3/crates/routecodex-v3-runtime/tests/hub_gemini_codec_characterization.rs',
  functionMap: 'docs/architecture/v3-function-map.yml',
  mainlineMap: 'docs/architecture/v3-mainline-call-map.yml',
  verificationMap: 'docs/architecture/v3-verification-map.yml',
  resourceMap: 'docs/architecture/v3-resource-operation-map.yml',
  packageJson: 'package.json',
  v3ArchitectureCi: 'scripts/architecture/verify-v3-architecture-ci.mjs',
  matrixReview: 'docs/architecture/reviews/v3-protocol-semantic-matrix-review.md',
  fieldMatrix: V3_PROTOCOL_SEMANTIC_FIELD_MATRIX_PATH,
  fieldMatrixHtml: V3_PROTOCOL_SEMANTIC_FIELD_MATRIX_HTML_PATH,
  fieldMatrixRenderer: 'scripts/architecture/render-v3-protocol-semantic-field-matrix.mjs',
};

const text = Object.fromEntries(Object.entries(paths).map(([key, path]) => [key, readFileSync(path, 'utf8')]));
const failures = [];
const fieldMatrix = YAML.parse(text.fieldMatrix);
const functionMap = YAML.parse(text.functionMap);
const mainlineMap = YAML.parse(text.mainlineMap);
const verificationMap = YAML.parse(text.verificationMap);
const requestFieldProjectionManifest = YAML.parse(text.requestFieldProjectionManifest);
const requestFieldProjectionModules = YAML.parse(text.requestFieldProjectionModules);

for (const phrase of [
  'request.reasoning_effort',
  'request.reasoning_budget_tokens',
  'request.reasoning_summary_policy',
  'request.reasoning_context_policy',
  'request.reasoning_mode',
  'request.reasoning_include_thoughts',
  'request.reasoning_display_policy',
  'request.reasoning_thinking_mode',
  'output_config.effort',
  'There is no `approximate`',
  'MetadataCenter is not a payload extension registry',
]) requireText(text.requestFieldProjectionDesign, paths.requestFieldProjectionDesign, phrase);
for (const semantic of [
  'request.metadata',
  'request.client_metadata',
  'request.prompt_cache_key',
  'request.store',
  'request.text.output_config',
  'request.reasoning_effort',
  'request.reasoning_budget_tokens',
  'request.reasoning_summary_policy',
  'request.reasoning_context_policy',
  'request.reasoning_mode',
  'request.reasoning_include_thoughts',
  'request.reasoning_display_policy',
  'request.reasoning_thinking_mode',
]) {
  if (!(requestFieldProjectionManifest?.payload_semantics ?? []).includes(semantic)) failures.push(`${paths.requestFieldProjectionManifest}: missing payload semantic ${semantic}`);
}
if (requestFieldProjectionManifest?.status !== 'design' || requestFieldProjectionManifest?.runtime_conformance !== 'pending') {
  failures.push(`${paths.requestFieldProjectionManifest}: design must not claim active runtime conformance before online verification`);
}
const projectionSemantics = new Map((requestFieldProjectionManifest?.semantic_registry ?? []).map((entry) => [entry?.semantic_id, entry]));
for (const [semanticId, chatStorage, projections] of [
  ['request.metadata', 'routecodex_chat_extension.responses_request.metadata', { responses: 'metadata_openai_limits', openai_chat: 'metadata_openai_limits', anthropic: 'user_id_to_provider_wire_other_keys_to_response_projection_context', gemini: 'unmapped' }],
  ['request.client_metadata', 'routecodex_chat_extension.responses_request.client_metadata', { responses: 'client_metadata', openai_chat: 'user_id_projection_other_fields_unmapped', anthropic: 'user_id_projection_other_fields_unmapped', gemini: 'unmapped' }],
  ['request.prompt_cache_key', 'routecodex_chat_extension.responses_request.prompt_cache_key', { responses: 'prompt_cache_key', openai_chat: 'prompt_cache_key', anthropic: 'unmapped', gemini: 'unmapped' }],
  ['request.store', 'routecodex_chat_extension.responses_request.store', { responses: 'store', openai_chat: 'store', anthropic: 'false_consumed_true_unsupported', gemini: 'unmapped' }],
  ['request.reasoning_effort', 'reasoning_effort', { responses: 'reasoning.effort', openai_chat: 'reasoning_effort', anthropic: 'output_config.effort_shared_domain_only', gemini: 'generationConfig.thinkingConfig.thinkingLevel_shared_domain_only' }],
  ['request.reasoning_budget_tokens', 'reasoning_budget_tokens', { responses: 'unmapped', openai_chat: 'unmapped', anthropic: 'thinking.budget_tokens_with_thinking_constraints', gemini: 'generationConfig.thinkingConfig.thinkingBudget_with_model_constraints' }],
  ['request.reasoning_summary_policy', 'reasoning_summary_policy', { responses: 'reasoning.summary', openai_chat: 'compatible_reasoning_effort_auto_medium_concise_low_detailed_high_merge_higher', anthropic: 'static_compatible_full_native_thinking_summary', gemini: 'unmapped' }],
  ['request.reasoning_context_policy', 'reasoning_context_policy', { responses: 'reasoning.context', openai_chat: 'unmapped', anthropic: 'unmapped', gemini: 'unmapped' }],
  ['request.reasoning_mode', 'reasoning_mode', { responses: 'reasoning.mode', openai_chat: 'unmapped', anthropic: 'unmapped', gemini: 'unmapped' }],
  ['request.reasoning_include_thoughts', 'reasoning_include_thoughts', { responses: 'unmapped', openai_chat: 'unmapped', anthropic: 'unmapped', gemini: 'generationConfig.thinkingConfig.includeThoughts' }],
  ['request.reasoning_display_policy', 'reasoning_display_policy', { responses: 'unmapped', openai_chat: 'unmapped', anthropic: 'thinking.display', gemini: 'unmapped' }],
  ['request.reasoning_thinking_mode', 'reasoning_thinking_mode', { responses: 'unmapped', openai_chat: 'unmapped', anthropic: 'thinking.type', gemini: 'unmapped' }],
]) {
  const entry = projectionSemantics.get(semanticId);
  if (!entry) {
    failures.push(`${paths.requestFieldProjectionManifest}: missing semantic_registry entry ${semanticId}`);
    continue;
  }
  if (entry.chat_storage !== chatStorage) failures.push(`${paths.requestFieldProjectionManifest}: ${semanticId} chat_storage must be ${chatStorage}`);
  for (const [protocol, projection] of Object.entries(projections)) {
    if (entry?.projections?.[protocol] !== projection) failures.push(`${paths.requestFieldProjectionManifest}: ${semanticId} ${protocol} projection must be ${projection}`);
  }
}
if (requestFieldProjectionModules?.global_module_registry_status !== 'pending') failures.push(`${paths.requestFieldProjectionModules}: must not claim complete global module registry`);
if (requestFieldProjectionModules?.status !== 'design_feature_scope' || requestFieldProjectionModules?.runtime_conformance !== 'pending') {
  failures.push(`${paths.requestFieldProjectionModules}: feature module registry must remain design/pending until runtime verification`);
}
const scopedOwnedPaths = (requestFieldProjectionModules?.modules ?? []).flatMap((module) => module.owned_paths ?? []);
for (const path of [paths.responsesOpenaiCodec, paths.requestOutboundFormat, paths.anthropicCodec, paths.anthropicProjectionContext, paths.anthropicRequestFieldProjection, paths.geminiCodec, paths.providerReqCompat]) {
  if (scopedOwnedPaths.filter((ownedPath) => ownedPath === path).length !== 1) failures.push(`${paths.requestFieldProjectionModules}: ${path} must have exactly one feature-scoped module owner`);
}
for (const [from, to, direction] of [
  ['V3HubReqChatProcess04Governed', 'v3.protocol_codec.provider_compat_dispatch', 'outbound'],
  ['v3.protocol_codec.provider_compat_dispatch', 'v3.protocol_codec.openai_outbound', 'outbound_openai'],
  ['v3.protocol_codec.provider_compat_dispatch', 'v3.protocol_codec.anthropic', 'outbound_anthropic'],
  ['v3.protocol_codec.provider_compat_dispatch', 'v3.protocol_codec.gemini', 'outbound_gemini_dispatch'],
]) {
  if (!(requestFieldProjectionModules?.allowed_edges ?? []).some((edge) => edge?.from === from && edge?.to === to && edge?.direction === direction)) {
    failures.push(`${paths.requestFieldProjectionModules}: missing adjacent ${direction} edge ${from} -> ${to}`);
  }
}

const outboundContract = fieldMatrix?.outbound_projection_contract;
for (const status of ['mapped', 'transformed', 'consumed_by_transform', 'target_unsupported', 'control_forbidden']) {
  if (!outboundContract?.legacy_outbound_consumption_statuses?.[status]) failures.push(`${paths.fieldMatrix}: missing legacy outbound projection status bridge ${status}`);
}
for (const phrase of ['mapped_exact', 'mapped_compatible_registered', 'unsupported']) {
  if (!String(JSON.stringify(outboundContract?.projection_class_bridge ?? {})).includes(phrase)) failures.push(`${paths.fieldMatrix}: projection class bridge missing ${phrase}`);
}
for (const phrase of ['UnmappedOutboundFields', 'ControlFieldLeak', 'recursive automatic strip', 'unknown source field ignore']) {
  if (!JSON.stringify(outboundContract ?? {}).includes(phrase)) failures.push(`${paths.fieldMatrix}: outbound projection contract missing ${phrase}`);
}
for (const field of ['request.include', 'request.client_metadata', 'request.container', 'request.safetySettings', 'metadata_center', '_debug']) {
  if (!JSON.stringify(outboundContract ?? {}).includes(field)) failures.push(`${paths.fieldMatrix}: outbound projection contract missing field ${field}`);
}

for (const phrase of [
  'Responses entry -> OpenAI Chat provider wire -> Responses client projection',
  'Anthropic Messages entry -> Responses provider wire -> Anthropic Messages client projection',
  'OpenAI Chat entry -> OpenAI Chat provider wire -> OpenAI Chat client projection',
  'Responses entry -> Anthropic Messages provider wire -> Responses client projection',
  'OpenAI metadata projection requires at most 16 string pairs',
  'Responses reasoning.summary, reasoning.context, and reasoning.mode',
  'Required red-first pairs for request-field projection',
  'docs/architecture/reviews/v3-protocol-semantic-matrix-review.md#canonical-textual-truth-for-the-field-matrix-audit',
  'docs/goals/v3-protocol-semantic-field-gap-closeout-plan.md',
  'Shape-branch contract that gates must preserve before runtime closeout',
  'shape_branch_cases.positive[]',
  'content.file_uri',
  'Forbidden owners: server handler, SSE transport, provider transport, continuation store, MetadataCenter, TS runtime, V2 sharedmodule code.',
  'RouteCodex-created control fields',
]) requireText(text.design, paths.design, phrase);

for (const phrase of [
  'V3 protocol semantic field gap closeout plan',
  'extension_declared`, `semantic_declared`, `source_inventory_only`',
  'gap.runtime_extension_declared',
  'gap.semantic_declared_runtime_closeout',
  'gap.partial_cross_protocol_semantics',
  'gap.source_inventory_only',
    'gap.shape_branch_transform',
    'gap.gemini_codec_shape_only',
    'Gemini inlineData/fileData shape branch source verification',
    'routecodex restart --port <locator-port>',
    'must not generate another prompt for the same objective',
]) requireText(text.gapCloseoutPlan, paths.gapCloseoutPlan, phrase);

const responsesToChat = functionSlice(
  text.responsesOpenaiCodec,
  paths.responsesOpenaiCodec,
  'pub(crate) fn build_v3_chat_canonical_request_from_responses_payload',
  'pub(crate) fn build_v3_chat_canonical_request_from_responses_payload_for_req_inbound',
);
for (const phrase of [
  'pub(crate) fn build_v3_chat_canonical_request_from_responses_payload',
  '"tool_choice"',
  '"parallel_tool_calls"',
  '"response_format"',
  '"stop"',
  '.entry("max_completion_tokens".to_string())',
  '"routecodex_chat_extension"',
  '"responses_request"',
  '"client_metadata"',
  '"prompt_cache_key"',
  '"store"',
  '"text"',
  'project_responses_reasoning_to_chat_fields',
  '"generate_summary"',
  'Unsupported Responses reasoning field',
  '"reasoning_summary_policy"',
  '"reasoning_context_policy"',
  '"reasoning_mode"',
  '"reasoning_effort"',
]) requireText(responsesToChat, `${paths.responsesOpenaiCodec}::build_v3_chat_canonical_request_from_responses_payload`, phrase);
forbid(responsesToChat, `${paths.responsesOpenaiCodec}::reasoning_policy_is_payload_not_prompt`, [
  /responses_reasoning_policy_as_target_valid_system_marker/,
  /<routecodex_reasoning_request/,
]);
for (const phrase of [
  'fn read_v3_responses_function_call_arguments_for_openai_chat',
  'fn project_v3_responses_arguments_to_openai_chat_wire(arguments: &str) -> String',
]) requireText(text.responsesOpenaiCodec, `${paths.responsesOpenaiCodec}::responses_arguments_payload_projection`, phrase);
const reqInbound02 = functionSlice(
  text.reqInbound02,
  paths.reqInbound02,
  'pub fn build_v3_hub_req_inbound_02_result_from_v3_hub_req_inbound_01',
  'pub fn build_v3_hub_req_inbound_02_responses_chat_canonical_from_v3_hub_req_inbound_01',
);
for (const phrase of [
  'if input.entry_protocol == V3HubEntryProtocol::Responses',
  'build_v3_chat_canonical_request_from_responses_payload_for_req_inbound',
  'if input.entry_protocol == V3HubEntryProtocol::Anthropic',
  'encode_v3_anthropic_request_as_responses_semantic',
  'Anthropic inbound Chat canonicalization failed',
  'semantic_protocol: V3HubRequestSemanticProtocol::Chat',
]) requireText(reqInbound02, `${paths.reqInbound02}::all_inbound_to_chat_canonical`, phrase);
forbid(reqInbound02, `${paths.reqInbound02}::all_inbound_to_chat_canonical_no_control_rebuild`, [
  /MetadataCenter|metadata_center|runtime_control|selected_target|provider_protocol/i,
  /original_responses_payload|responses_payload_needs_req04_original_surface/,
]);
const responsesArgumentProjector = functionSlice(
  text.responsesOpenaiCodec,
  paths.responsesOpenaiCodec,
  'fn project_v3_responses_arguments_to_openai_chat_wire(arguments: &str) -> String',
  'fn build_v3_openai_chat_tool_result_message',
);
requireText(responsesArgumentProjector, `${paths.responsesOpenaiCodec}::responses_arguments_payload_projection`, 'arguments.to_string()');
forbid(responsesArgumentProjector, `${paths.responsesOpenaiCodec}::responses_arguments_payload_projection`, [
  /serde_json::to_string|Value::String|Map::new|json!\(\{\}\)|"\{\}"\.to_string\(\)|matching_parse_feedback|function_call_output|tool_result/,
]);
requireOrder(responsesToChat, `${paths.responsesOpenaiCodec}::responses_to_chat_copy_list`, [
  '"stop"',
  'if let Some(metadata) = root.get("metadata")',
  'if let Some(client_metadata) = root.get("client_metadata")',
  '.entry("max_completion_tokens".to_string())',
]);
forbid(responsesToChat, `${paths.responsesOpenaiCodec}::build_v3_chat_canonical_request_from_responses_payload`, [
  /fallback/i,
  /MetadataCenter|metadata_center|runtime_control/i,
  /"anthropic_entry_system"|"context_management"|"output_config"|"safety_identifier"|"moderation"|"include"|"stream_options"/,
  /summary_requests_reasoning \|\| object\.get\("context"\)\.is_some\(\).*medium/s,
  /if\s+matching_parse_feedback\s*\{/,
]);

const requestOutbound = functionSlice(
  text.requestOutboundFormat,
  paths.requestOutboundFormat,
  'pub(crate) fn build_v3_openai_chat_standard_request_from_chat_canonical',
  'pub(crate) fn build_v3_openai_responses_standard_request_from_chat_canonical',
);
for (const phrase of [
  'pub(crate) fn build_v3_openai_chat_standard_request_from_chat_canonical',
  'normalize_openai_chat_messages_payload',
]) requireText(requestOutbound, `${paths.requestOutboundFormat}::build_v3_openai_chat_standard_request_from_chat_canonical`, phrase);
for (const phrase of [
  'normalize_responses_target_token_and_logprob_fields',
  'row.remove("max_completion_tokens")',
  'row.remove("max_tokens")',
  'row.insert("max_output_tokens".to_string(), value)',
  '.remove("logprobs")',
  'row.insert("top_logprobs".to_string(), value)',
  'normalize_responses_function_tool_schema_redaction_placeholders(&mut normalized)?',
  'normalize_json_schema_redaction_placeholders',
  'project_outbound_payload_for_target_protocol',
  'ControlFieldLeak target_protocol={}',
  'UnmappedOutboundFields target_protocol={}',
  'fn is_provider_outbound_control_key',
  '"metadata_center"',
  '"runtime_control"',
]) requireText(text.requestOutboundFormat, paths.requestOutboundFormat, phrase);
requireText(
  text.requestOutboundToolProjection,
  paths.requestOutboundToolProjection,
  'normalize_json_schema_redaction_placeholders',
);
requireText(text.requestOutboundFormat, `${paths.requestOutboundFormat}::explicit_outbound_projection`, 'project_outbound_payload_for_target_protocol');
requireText(text.requestOutboundFormat, `${paths.requestOutboundFormat}::explicit_outbound_projection`, 'ControlFieldLeak target_protocol={}');
requireText(text.requestOutboundFormat, `${paths.requestOutboundFormat}::explicit_outbound_projection`, 'UnmappedOutboundFields target_protocol={}');
forbid(text.requestOutboundFormat, `${paths.requestOutboundFormat}::no_silent_strip_projector`, [
  /strip_private_fields/,
  /!is_provider_outbound_control_key\(key\)\s*&&\s*!key\.starts_with\('_'\)/,
  /row\.remove\("client_metadata"\);\s*if\s*let\s*Some\(max_output_tokens\)/,
  /row\.remove\("include"\)/,
  /row\.remove\("reasoning"\)/,
]);
requireText(text.requestOutboundMetadata, `${paths.requestOutboundMetadata}::responses_client_metadata_projection`, 'pub(super) fn project_openai_client_metadata_to_metadata');
requireText(text.clientMetadataProjection, `${paths.clientMetadataProjection}::client_metadata_user_id_only`, 'pub(super) fn unsupported_client_metadata_paths(');
requireText(text.clientMetadataProjection, `${paths.clientMetadataProjection}::registered_client_local_metadata`, 'REGISTERED_CLIENT_LOCAL_METADATA_KEYS');
requireText(text.clientMetadataProjection, `${paths.clientMetadataProjection}::registered_client_local_metadata`, '"x-codex-turn-metadata"');
requireText(text.clientMetadataProjection, `${paths.clientMetadataProjection}::unknown_client_metadata_rejected`, '!REGISTERED_CLIENT_LOCAL_METADATA_KEYS.contains(&key.as_str())');
forbid(text.clientMetadataProjection, `${paths.clientMetadataProjection}::no_unknown_client_metadata_silent_consumption`, [
  /CONSUMED_CODEX_CLIENT_METADATA_KEYS/,
  /"unknown"/,
]);
forbid(text.clientMetadataProjection, `${paths.clientMetadataProjection}::no_provider_header_projection`, [/V3StandardRequestHeaderGroup/, /anthropic_provider_headers/, /build_v3_anthropic_provider_request_header/, /x-claude-code-session-id/, /x-codex-turn-metadata.*headers/s]);
requireText(text.requestOutboundMetadata, `${paths.requestOutboundMetadata}::registered_codex_client_metadata`, 'unsupported_client_metadata_paths(client_metadata)');
requireText(text.anthropicCodec, `${paths.anthropicCodec}::registered_codex_client_metadata`, 'unsupported_client_metadata_paths(client_metadata)');
requireText(text.anthropicRequestFieldProjection, `${paths.anthropicRequestFieldProjection}::registered_codex_client_metadata`, 'unsupported_client_metadata_paths(client_metadata)');
const responsesProviderRequestBuilder = functionSlice(
  text.requestOutboundFormat,
  paths.requestOutboundFormat,
  'fn build_v3_openai_responses_request_from_chat_canonical',
  'fn normalize_responses_payload_for_provider_standard',
);
requireText(responsesProviderRequestBuilder, `${paths.requestOutboundFormat}::responses_client_metadata_preserved`, '"metadata",\n        "client_metadata",');
const outboundProjectionTransforms = functionSlice(
  text.requestOutboundFormat,
  paths.requestOutboundFormat,
  'fn apply_outbound_projection_transforms',
  'fn project_responses_request_chat_extension_to_openai_responses',
);
forbid(outboundProjectionTransforms, `${paths.requestOutboundFormat}::responses_client_metadata_not_renamed`, [/project_openai_client_metadata_to_metadata\(projected, "responses"\)/]);
requireText(text.requestOutboundFormat, `${paths.requestOutboundFormat}::openai_chat_target_validation_after_projection`, 'project_openai_client_metadata_to_metadata(projected, "openai_chat")?;\n            validate_openai_metadata(projected, "openai_chat")?;');
requireText(text.requestOutboundFormatExtraTests, `${paths.requestOutboundFormatExtraTests}::openai_chat_reasoning_summary_negative`, 'fn openai_chat_wire_rejects_invalid_reasoning_summary_policy()');
requireText(text.requestOutboundFormatExtraTests, `${paths.requestOutboundFormatExtraTests}::openai_chat_reasoning_summary_compatible_projection`, 'fn openai_chat_wire_projects_reasoning_summary_policy_without_wire_loss()');
requireText(text.requestOutboundMetadata, `${paths.requestOutboundMetadata}::openai_chat_reasoning_summary_compatible_projection`, 'pub(super) fn project_openai_chat_reasoning_summary_policy');
requireText(text.requestFieldProjectionManifest, `${paths.requestFieldProjectionManifest}::openai_chat_reasoning_summary_compatible_projection`, 'compatible_reasoning_effort_auto_medium_concise_low_detailed_high_merge_higher');
requireText(text.requestOutboundFormatExtraTests, `${paths.requestOutboundFormatExtraTests}::openai_chat_registered_client_metadata_local_context`, 'openai_chat_wire_consumes_registered_codex_client_metadata_as_local_context');
requireText(text.requestOutboundFormatExtraTests, `${paths.requestOutboundFormatExtraTests}::openai_chat_unknown_client_metadata_rejected`, 'openai_chat_wire_rejects_unknown_client_metadata_before_provider_wire');
requireText(text.requestOutboundFormatExtraTests, `${paths.requestOutboundFormatExtraTests}::responses_client_metadata_target_validation_lock`, 'codex_client_metadata_remains_client_metadata_on_responses_wire');
requireText(text.requestOutboundFormat, `${paths.requestOutboundFormat}::responses_reasoning_projection`, 'fn project_openai_responses_reasoning_extensions_to_reasoning');
requireText(text.requestOutboundFormat, `${paths.requestOutboundFormat}::openai_chat_max_output_tokens_mapping`, 'row.entry("max_completion_tokens".to_string())');
for (const phrase of [
  'openai_chat_provider_wire_consumes_registered_codex_client_metadata_as_local_context',
  'openai_chat_function_tool_redacted_schema_placeholders_fail_fast',
  'openai_chat_function_tool_redacted_schema_placeholders_fail_fast_in_defs',
  'openai_chat_tool_search_rejects_unmapped_builtin_tool',
  'openai_responses_function_tool_redacted_schema_placeholders_fail_fast',
  'openai_responses_function_tool_redacted_schema_placeholders_fail_fast_in_definitions',
  'openai_responses_provider_wire_maps_chat_token_and_logprob_pairs',
  'openai_responses_provider_wire_drops_top_logprobs_when_logprobs_disabled',
  'Responses provider wire must not emit non-spec max_tokens',
  'redacted_schema_placeholder',
]) requireText(text.hubTests, paths.hubTests, phrase);
requireText(
  text.requestOutboundFormatExtraTests,
  paths.requestOutboundFormatExtraTests,
  'responses_wire_projects_non_fc_function_item_ids_to_matching_fc_ids',
);
requireText(
  text.requestOutboundFormat,
  `${paths.requestOutboundFormat}::responses_function_item_id`,
  'Some(item_id) => compact_tool_id("fc_", item_id)',
);
forbid(text.requestOutboundFormat, `${paths.requestOutboundFormat}::metadata_data_plane`, [/contains\("metadata"\)/, /metadata.*side-channel fields/i]);

const chatToResponses = functionSlice(
  text.responsesRuntime,
  paths.responsesRuntime,
  'fn build_v3_responses_provider_response_from_openai_chat_payload',
  'fn parse_v3_openai_chat_tool_call_arguments',
);
for (const phrase of [
  'fn build_v3_responses_provider_response_from_openai_chat_payload',
  'if let Some(model) = payload.get("model") {\n        response.insert("model".to_string(), model.clone());\n    }',
  'payload.get("created_at").or_else(|| payload.get("created"))',
  'normalize_v3_hub_responses_usage_from_openai_chat_usage',
  'build_v3_responses_reasoning_item_from_openai_chat_message',
  'build_v3_responses_function_call_from_openai_chat_tool_call',
]) requireText(chatToResponses, `${paths.responsesRuntime}::chat_to_responses_projection`, phrase);
forbid(chatToResponses, `${paths.responsesRuntime}::chat_to_responses_projection`, [/fallback/i, /MetadataCenter|metadata_center|runtime_control/i]);

const anthropicToResponses = functionSlice(
  text.anthropicCodec,
  paths.anthropicCodec,
  'pub fn encode_v3_anthropic_request_as_responses_semantic',
  'pub fn characterize_v3_anthropic_client_input_to_hub_semantic',
);
for (const phrase of [
  'pub fn encode_v3_anthropic_request_as_responses_semantic',
  '"metadata"',
  '"temperature"',
  '"top_p"',
  '"top_k"',
  '"parallel_tool_calls"',
  'object.get("stop_sequences")',
  '"reasoning_thinking_mode"',
  '"reasoning_budget_tokens"',
  '"reasoning_display_policy"',
  '"anthropic_request"',
  'anthropic_tool_choice_as_responses_tool_choice',
]) requireText(anthropicToResponses, `${paths.anthropicCodec}::anthropic_to_responses`, phrase);
forbid(anthropicToResponses, `${paths.anthropicCodec}::anthropic_to_responses`, [/fallback/i, /MetadataCenter|metadata_center|debug_snapshot|runtime_control/i, /anthropic_entry_system/]);

const responsesRequestToAnthropic = functionSlice(
  text.anthropicCodec,
  paths.anthropicCodec,
  'pub fn encode_v3_responses_semantic_as_anthropic_request',
  'pub fn project_v3_anthropic_message_as_responses_response',
);
for (const phrase of [
  'pub fn encode_v3_responses_semantic_as_anthropic_request',
  'responses_reasoning_fields_as_anthropic_thinking',
  'project_chat_reasoning_effort_as_anthropic_output_config',
  'reject_unmapped_anthropic_payload_extensions',
  '"output_config"',
  '"effort"',
  '"budget_tokens"',
  'output.insert("thinking".to_string(), thinking)',
  '.or_else(|| object.get("max_completion_tokens"))',
  'output.insert("max_tokens".to_string(), value.to_owned())',
  'responses_metadata_as_anthropic_metadata',
  'responses_request_chat_extension',
  'anthropic_request_system_extension',
  'project_responses_text_as_anthropic_output_config',
  '$.request.client_metadata',
  '"metadata" | "client_metadata" | "prompt_cache_key" | "store" | "text"',
]) requireText(responsesRequestToAnthropic, `${paths.anthropicCodec}::responses_request_to_anthropic`, phrase);
forbid(responsesRequestToAnthropic, `${paths.anthropicCodec}::responses_request_to_anthropic`, [/MetadataCenter|metadata_center|debug_snapshot|runtime_control/i, /responses_reasoning_effort_as_anthropic_budget/, /responses_reasoning_policy_as_anthropic_system_marker/, /<routecodex_reasoning_request/, /unwrap_or_else\(\|\|\s*\{?\s*responses_reasoning_effort_as_anthropic_budget/s]);
forbid(text.anthropicCodec, `${paths.anthropicCodec}::registered_anthropic_system_extension`, [/anthropic_entry_system/]);
for (const phrase of ['responses_metadata_as_anthropic_metadata', 'pub(super) fn validate_responses_cache_and_store_for_anthropic(', 'pub(super) fn reject_responses_reasoning_summary_for_anthropic(', 'pub(super) fn project_responses_text_as_anthropic_output_config(', 'extension.get("prompt_cache_key")', 'extension.get("store")', 'Some(false) => {}', 'Some(true) => {', 'matches!(value, "auto" | "concise" | "detailed")']) requireText(text.anthropicRequestFieldProjection, paths.anthropicRequestFieldProjection, phrase);
for (const phrase of [
  'pub(super) fn openai_chat_tool_call_as_anthropic_tool_use(',
  'serde_json::from_str(raw).unwrap_or_else(|_| json!({"input": raw}))',
  'Ok(serde_json::from_str(raw).unwrap_or_else(|_| json!({"input": raw})))',
]) requireText(text.responsesToAnthropicCodec, `${paths.responsesToAnthropicCodec}::malformed_chat_tool_arguments`, phrase);
for (const phrase of [
  'responses_custom_tool_as_anthropic_compatibility_tool',
  'v3.custom_tool.anthropic_string_input_wrapper.v1',
  'input_schema',
  '"additionalProperties":false',
]) requireText(text.responsesToAnthropicCodec, `${paths.responsesToAnthropicCodec}::anthropic_custom_declaration_projection`, phrase);
requireText(text.anthropicCodecTests, `${paths.anthropicCodecTests}::malformed_chat_tool_arguments`, 'chat_malformed_tool_call_arguments_keep_pair_with_reversible_anthropic_input');
requireText(text.anthropicCodecTests, `${paths.anthropicCodecTests}::malformed_responses_function_arguments`, 'responses_malformed_function_call_arguments_keep_pair_with_reversible_anthropic_input');
for (const phrase of [
  'responses_custom_tool_call_missing_input_fails_without_empty_object_repair',
  'responses_custom_tool_call_non_string_input_fails_without_relabel_or_repair',
  'responses_valid_function_arguments_use_native_anthropic_object_input',
]) requireText(text.anthropicCodecTests, `${paths.anthropicCodecTests}::registered_compatibility_shapes`, phrase);
requireText(text.requestFieldProjectionDesign, paths.requestFieldProjectionDesign, 'v3.function_call.anthropic_raw_argument_wrapper.v1');
requireText(text.requestFieldProjectionManifest, paths.requestFieldProjectionManifest, 'v3.function_call.anthropic_raw_argument_wrapper.v1');
requireText(text.fieldMatrix, paths.fieldMatrix, 'v3.function_call.anthropic_raw_argument_wrapper.v1');
requireText(text.requestOutboundToolProjection, `${paths.requestOutboundToolProjection}::responses_web_search_projection`, 'pub(super) fn project_openai_chat_provider_tools(');
requireText(text.requestOutboundToolProjection, `${paths.requestOutboundToolProjection}::responses_tool_search_projection`, 'fn normalize_openai_chat_tool_search(');
const openaiChatCustomToolProjection = functionSlice(
  text.requestOutboundToolProjection,
  paths.requestOutboundToolProjection,
  'fn normalize_openai_chat_custom_tool(',
  'fn normalize_openai_chat_tool_search(',
);
// 现状契约（opencode-go 兼容）：custom -> function 扁平化（parameters 最小
// {"type":"object"}），format(grammar) 按协议收窄丢弃，未知字段必须拒绝
// （UnmappedOutboundFields），禁止静默降级丢失。
for (const phrase of [
  'Value::String("function".to_string())',
  'UnmappedOutboundFields',
  '"type":"object"',
]) requireText(openaiChatCustomToolProjection, `${paths.requestOutboundToolProjection}::native_openai_chat_custom_tool`, phrase);
forbid(openaiChatCustomToolProjection, `${paths.requestOutboundToolProjection}::native_openai_chat_custom_tool`, [/Value::String\("custom"\.to_string\(\)/]);
requireText(text.requestOutboundFormatExtraTests, `${paths.requestOutboundFormatExtraTests}::responses_web_search_projection`, 'openai_chat_wire_projects_responses_web_search_tool_to_options');
for (const testName of [
  'openai_chat_wire_projects_complete_codex_tool_declaration_matrix',
  // grammar 投影行为已移除（chat wire 无法表达 format，按协议收窄丢弃），
  // 仅保留拒绝未知格式（openai_chat_wire_rejects_unknown_custom_format_without_function_downgrade）。
  'openai_chat_wire_rejects_unknown_custom_format_without_function_downgrade',
]) requireText(text.requestOutboundFormatExtraTests, `${paths.requestOutboundFormatExtraTests}::native_openai_chat_custom_tool_tests`, testName);
for (const testName of [
  'responses_custom_tool_projects_registered_anthropic_wrapper',
  'responses_named_custom_tool_choice_projects_registered_anthropic_tool_choice',
  'responses_named_custom_tool_choice_without_name_fails',
  'anthropic_registered_custom_wrapper_restores_exact_responses_raw_input',
  'anthropic_unregistered_input_wrapper_is_not_unwrapped_as_custom',
  'anthropic_custom_wrapper_rejects_extra_or_non_string_input_without_repair',
]) requireText(text.anthropicCodecTests, `${paths.anthropicCodecTests}::anthropic_custom_wrapper_tests`, testName);
for (const phrase of [
  'if object.get("type").and_then(Value::as_str) == Some("custom")',
  '.get("custom")',
  'custom_tool_names.contains(name)',
  '.get("input")',
  '"type":"custom_tool_call"',
]) requireText(text.responsesRuntime, `${paths.responsesRuntime}::native_openai_chat_custom_tool_response`, phrase);
forbid(text.responsesRuntime, `${paths.responsesRuntime}::no_function_relabel_for_openai_chat_custom`, [/extract_v3_responses_custom_tool_input_from_openai_chat_arguments/]);
requireText(text.responsesRuntime, `${paths.responsesRuntime}::projection_failure_switches_without_invalid_wire`, 'target_protocol_unmapped_field_skips_invalid_wire_and_switches_provider');
requireText(text.responsesRuntime, `${paths.responsesRuntime}::projection_failure_switches_without_invalid_wire`, 'the incompatible Anthropic candidate must receive no wire request');
requireText(text.anthropicProjectionContext, `${paths.anthropicProjectionContext}::responses_metadata_projection_context`, 'pub struct V3AnthropicResponsesProjectionContext');
for (const phrase of ['custom_tool_names: BTreeSet<String>', 'governed_custom_tool_names']) requireText(text.anthropicProjectionContext, `${paths.anthropicProjectionContext}::anthropic_custom_reverse_guard`, phrase);
requireText(text.anthropicCodecToolProjection, `${paths.anthropicCodecToolProjection}::anthropic_custom_reverse_guard`, 'anthropic_tool_use_as_responses_call');
requireText(text.responsesAnthropicProviderTests, `${paths.responsesAnthropicProviderTests}::responses_metadata_projection_context`, 'responses_relay_anthropic_provider_restores_response_metadata_without_wire_leak');
forbid(text.responsesToAnthropicCodec, `${paths.responsesToAnthropicCodec}::malformed_chat_tool_arguments`, [/field: "tool_call[.]arguments"/, /field: "function_call[.]arguments"/]);
requireText(text.requestFieldProjectionModules, `${paths.requestFieldProjectionModules}::anthropic_codec_owner`, paths.responsesToAnthropicCodec);
requireText(text.requestFieldProjectionModules, `${paths.requestFieldProjectionModules}::shared_client_metadata_owner`, paths.clientMetadataProjection);
forbid(text.anthropicRequestFieldProjection, `${paths.anthropicRequestFieldProjection}::no_invented_anthropic_fields`, [/output\.insert\("cache_control"/, /ANTHROPIC_USER_ID_SOURCE_PRIORITY/]);
forbid(responsesRequestToAnthropic, `${paths.anthropicCodec}::responses_reasoning_summary_consumed`, [/consume_responses_reasoning_summary_for_anthropic_response_projection/]);
forbid(text.anthropicRequestFieldProjection, `${paths.anthropicRequestFieldProjection}::compatible_fields_only`, [/MetadataCenter|metadata_center|debug_snapshot|runtime_control/i, /"effort",\s*verbosity\.clone\(\)/s]);
requireText(text.providerReqCompat, `${paths.providerReqCompat}::client_metadata_local_context`, 'responses_registered_client_metadata_is_local_context_at_anthropic_target_codec');
requireText(text.providerReqCompat, `${paths.providerReqCompat}::prompt_cache_key_local_hint`, 'responses_prompt_cache_key_is_registered_local_cache_hint_for_anthropic');
requireText(text.providerReqCompat, `${paths.providerReqCompat}::supported_verbosity_local_hint`, 'responses_supported_verbosity_is_registered_local_style_hint_for_anthropic');
requireText(text.providerReqCompat, `${paths.providerReqCompat}::store_true_unmapped`, 'responses_store_true_fails_when_anthropic_cannot_preserve_remote_storage_semantics');
requireText(text.providerReqCompat, `${paths.providerReqCompat}::verbosity_value_domain`, 'responses_unsupported_verbosity_fails_at_anthropic_adjacent_codec');
requireText(text.providerReqCompat, `${paths.providerReqCompat}::exact_anthropic_fields`, 'responses_exact_client_user_id_and_json_schema_project_to_anthropic_wire');
requireText(text.responsesAnthropicProviderTests, `${paths.responsesAnthropicProviderTests}::codex_client_metadata_local_context`, 'responses_relay_consumes_registered_codex_client_metadata_before_provider_wire');
forbid(text.responsesAnthropicProviderTests, `${paths.responsesAnthropicProviderTests}::codex_client_metadata_provider_wire_leak`, [/assert_eq!\(headers\["x-claude-code-session-id"\]/, /assert_eq!\(headers\["x-codex-turn-metadata"\]/]);
requireText(text.anthropicTests, `${paths.anthropicTests}::structured_system_unmapped`, 'anthropic_structured_system_extension_is_not_silently_flattened_for_responses');
const openaiChatExtensionProjection = functionSlice(
  text.requestOutboundFormat,
  paths.requestOutboundFormat,
  'fn project_responses_request_chat_extension_to_openai_chat',
  'fn project_responses_text_format_to_openai_chat_response_format',
);
requireText(openaiChatExtensionProjection, `${paths.requestOutboundFormat}::registered_extension_unmapped`, '.map(|key| format!("$.request.{key}"))');

const providerReqCompat = functionSlice(
  text.providerReqCompat,
  paths.providerReqCompat,
  'fn build_v3_provider_standard_protocol_payload_from_req07',
  '#[cfg(test)]',
);
for (const phrase of [
  'V3HubProviderWireProtocol::Anthropic',
  'let source = build_v3_anthropic_provider_request_source_from_chat_canonical(',
  'encode_v3_responses_semantic_as_anthropic_request(source)',
  'input.provider_semantic_payload()',
  'input.entry_protocol()',
]) requireText(providerReqCompat, `${paths.providerReqCompat}::anthropic_chat_extension_surface`, phrase);
forbid(providerReqCompat, `${paths.providerReqCompat}::anthropic_chat_extension_surface`, [/fallback/i, /original_responses_payload|MetadataCenter|metadata_center|runtime_control/i]);

const anthropicProviderRequestSource = functionSlice(
  text.requestOutboundFormat,
  paths.requestOutboundFormat,
  'pub(crate) fn build_v3_anthropic_provider_request_source_from_chat_canonical',
  '#[derive(Debug, Clone, Copy, PartialEq, Eq)]',
);
for (const phrase of [
  'V3HubEntryProtocol::Responses',
  'if payload.get("messages").and_then(Value::as_array).is_some()',
  'Responses entry to Anthropic provider wire requires governed Chat extension messages',
  'V3HubEntryProtocol::Anthropic | V3HubEntryProtocol::OpenAiChat',
  'Anthropic provider wire requires governed Chat/Anthropic messages',
]) requireText(anthropicProviderRequestSource, `${paths.requestOutboundFormat}::anthropic_provider_request_source`, phrase);
forbid(anthropicProviderRequestSource, `${paths.requestOutboundFormat}::anthropic_provider_request_source`, [/fallback/i, /original_responses_payload|build_v3_responses_original_input_surface|MetadataCenter|metadata_center|runtime_control/i]);
forbid(anthropicProviderRequestSource, `${paths.requestOutboundFormat}::anthropic_provider_request_source_no_raw_input_branch`, [
  /payload\.get\("input"\)\.and_then\(Value::as_array\)\.is_some\(\)/,
  /normalize_responses_payload_for_provider_standard\(payload\)/,
  /Responses input/,
]);
const openAiChatStandardRequest = functionSlice(
  text.requestOutboundFormat,
  paths.requestOutboundFormat,
  'pub(crate) fn build_v3_openai_chat_standard_request_from_chat_canonical',
  'pub(crate) fn build_v3_openai_responses_standard_request_from_chat_canonical',
);
forbid(openAiChatStandardRequest, `${paths.requestOutboundFormat}::openai_chat_outbound_no_raw_responses_rebuild`, [
  /build_v3_chat_canonical_request_from_responses_payload/,
  /payload\.get\("input"\)/,
]);
const openAiResponsesStandardRequest = functionSlice(
  text.requestOutboundFormat,
  paths.requestOutboundFormat,
  'pub(crate) fn build_v3_openai_responses_standard_request_from_chat_canonical',
  'fn normalize_responses_payload_for_provider_standard',
);
forbid(openAiResponsesStandardRequest, `${paths.requestOutboundFormat}::responses_outbound_requires_chat_canonical`, [
  /payload\.get\("input"\)\.and_then\(Value::as_array\)\.is_some\(\)/,
  /return Ok\(normalize_responses_payload_for_provider_standard\(payload\)\)/,
]);
forbid(text.requestOutboundFormat, `${paths.requestOutboundFormat}::no_original_responses_payload_rebuild`, [
  /build_v3_responses_original_input_surface_from_chat_canonical/,
  /merge_chat_governance_into_original_responses_surface/,
  /original_responses_payload/,
]);
requireText(text.requestOutboundFormat, `${paths.requestOutboundFormat}::chat_extension_payload_only`, 'routecodex_chat_extension');
forbid(text.requestOutboundFormat, `${paths.requestOutboundFormat}::chat_extension_payload_only_no_metadata_rebuild`, [
  /MetadataCenter.*routecodex_chat_extension|routecodex_chat_extension.*MetadataCenter/s,
]);

const responsesToAnthropic = functionSlice(
  text.anthropicProjection,
  paths.anthropicProjection,
  'pub fn project_v3_responses_json_as_anthropic_message',
  'pub fn project_v3_responses_json_as_anthropic_events',
);
for (const phrase of [
  'pub fn project_v3_responses_json_as_anthropic_message',
  'project_v3_responses_reasoning_item_as_anthropic_content',
  'parse_responses_function_call_arguments',
  'responses_custom_tool_call_input',
  '"usage"',
  'responses_stop_reason_as_anthropic_stop_reason',
]) requireText(responsesToAnthropic, `${paths.anthropicProjection}::responses_to_anthropic`, phrase);
forbid(responsesToAnthropic, `${paths.anthropicProjection}::responses_to_anthropic`, [/fallback/i, /unwrap_or_else\(\|\|\s*json!\(\{\}\)\)/]);

for (const [owner, body, phrases] of [
  [paths.responsesTests, text.responsesTests, [
    'responses_openai_chat_field_parity_request_matrix',
    'responses_openai_chat_field_parity_response_matrix',
    '"metadata":{"client":"metadata-kept"}',
    'body["reasoning_effort"]',
    'body["max_completion_tokens"]',
    'OpenAI Chat provider wire must map only Responses reasoning.effort to reasoning_effort',
    'OpenAI Chat provider wire must reject unsupported client_metadata',
    'responses_openai_chat_field_parity_paired_malformed_arguments_preserve_exact_string_without_reselect',
    'responses_openai_chat_field_parity_unpaired_malformed_arguments_preserve_exact_string_without_reselect',
    '!result.node_trace.contains(&"V3TargetLocalReselected")',
    'observability.provider_failure_events.is_empty()',
    'OpenAI Chat function.arguments must preserve the exact original string bytes',
    'parse-failure tool result must remain paired',
    'http://chatwire.invalid/v1/chat/completions',
  ]],
  [paths.responsesAnthropicProviderTests, text.responsesAnthropicProviderTests, [
    'responses_relay_reasoning_effort_projects_anthropic_output_config_effort',
    'responses_relay_reasoning_summary_policy_is_consumed_before_anthropic_wire',
    'responses_relay_anthropic_provider_json_preserves_thinking_to_responses_reasoning',
    'responses_relay_anthropic_provider_restores_response_metadata_without_wire_leak',
    'must not synthesize thinking budget from Responses effort',
    'reasoning_summary_policy',
    '"type":"thinking"',
  ]],
  [paths.anthropicTests, text.anthropicTests, [
    'anthropic_responses_field_parity_request_matrix',
    'anthropic_responses_field_parity_response_matrix',
    'anthropic_responses_field_parity_rejects_malformed_function_arguments',
  ]],
  [paths.openaiTests, text.openaiTests, [
    'openai_chat_same_protocol_field_parity_request_response_matrix',
    'run_openai_chat_same_protocol_field_parity_request_response_matrix',
  ]],
]) for (const phrase of phrases) requireText(body, owner, phrase);


for (const phrase of [
  'responses_openai_chat_field_parity_responses_wire_projects_fc_item_ids',
  'responses_openai_chat_field_parity_responses_wire_generates_collision_resistant_fc_ids',
  'responses_openai_chat_field_parity_responses_wire_hashes_sanitized_collisions',
  'responses_openai_chat_field_parity_responses_wire_preserves_include_projection',
  'responses_openai_chat_field_parity_include_is_rejected_from_chat_wire',
  'openai_chat_wire_preserves_same_protocol_request_fields',
  'relay_responses_wire_rejects_unconsumed_previous_response_id',
  'relay_responses_wire_preserves_non_continuation_provider_fields',
]) requireText(
  `${text.requestOutboundFormat}
${text.requestOutboundFormatExtraTests}`,
  `${paths.requestOutboundFormat}+${paths.requestOutboundFormatExtraTests}`,
  phrase,
);
const outboundAllowedFields = functionSlice(
  text.requestOutboundFormat,
  paths.requestOutboundFormat,
  'fn allowed_top_level_outbound_fields',
  'fn normalize_responses_content_part_for_role',
);
// 出站顶层字段白名单真源已收敛为查表（request_field_map.json，allowed_top_level_outbound_fields
// 只做协议名查表）；openai_chat 允许字段改为校验 JSON 表，不再扫描源码数组字面量。
const requestFieldMapRel = 'v3/crates/routecodex-v3-runtime/tables/request_field_map.json';
const requestFieldMap = JSON.parse(readFileSync(requestFieldMapRel, 'utf8'));
const openAiChatAllowedFields = (requestFieldMap?.whitelists?.openai_chat ?? []).join('\n');
for (const field of [
  'audio',
  'modalities',
  'prediction',
  'prompt_cache_key',
  'prompt_cache_options',
  'prompt_cache_retention',
  'service_tier',
  'store',
  'web_search_options',
]) requireText(openAiChatAllowedFields, `${requestFieldMapRel}::whitelists.openai_chat`, field);
const responsesAllowedFields = sectionSlice(
  outboundAllowedFields,
  'V3OutboundTargetProtocol::OpenAiResponses => &[',
  'V3OutboundTargetProtocol::Anthropic => &[',
);
forbid(
  responsesAllowedFields,
  `${paths.requestOutboundFormat}::relay_continuation_owner_consumed_before_outbound`,
  [/"previous_response_id"/],
);
for (const phrase of [
  'responses_openai_chat_field_parity_direct_kernel_preserves_responses_input_include_and_tool_history',
  'direct provider wire payload captured',
  'Direct must not synthesize Chat messages',
]) requireText(text.directPassthroughTests, paths.directPassthroughTests, phrase);
for (const phrase of [
  '--lib responses_openai_chat_field_parity',
  '--test responses_direct_tool_passthrough responses_openai_chat_field_parity',
  '--test responses_relay_local_continuation_integration responses_openai_chat_field_parity',
]) requireText(text.packageJson, 'package.json::test:v3-protocol-conversion-field-parity', phrase);

const unpairedMalformedOpenAiChatTest = functionSlice(
  text.responsesTests,
  paths.responsesTests,
  'async fn responses_openai_chat_field_parity_unpaired_malformed_arguments_preserve_exact_string_without_reselect',
  'async fn responses_openai_chat_field_parity_web_search_call_history_projects_tool_pair',
);
for (const phrase of [
  '!result.node_trace.contains(&"V3TargetLocalReselected")',
  'observability.provider_failure_events.is_empty()',
  'wire_arguments, malformed_arguments',
]) requireText(
  unpairedMalformedOpenAiChatTest,
  `${paths.responsesTests}::responses_openai_chat_field_parity_unpaired_malformed_arguments_preserve_exact_string_without_reselect`,
  phrase,
);
forbid(unpairedMalformedOpenAiChatTest, `${paths.responsesTests}::unpaired_malformed_arguments_projection`, [
  /provider_request_compat_error|matching parse-failure/,
]);

for (const [owner, body, phrases] of [
  [paths.functionMap, text.functionMap, [
    'feature_id: v3.protocol_conversion_field_parity',
    'v3-protocol-field-parity-responses-chat-req-01',
    'v3-protocol-field-parity-responses-chat-malformed-arguments-project-01',
    'v3-protocol-field-parity-responses-chat-resp-01',
    'v3-protocol-field-parity-responses-anthropic-req-01',
    'v3-protocol-field-parity-anthropic-responses-req-01',
    'v3-protocol-field-parity-responses-anthropic-resp-01',
    'v3-protocol-field-parity-openai-chat-same-protocol-01',
    'npm run render:v3-protocol-semantic-field-matrix',
    'npm run verify:v3-protocol-conversion-field-parity',
    'npm run test:v3-protocol-conversion-field-parity-red-fixtures',
    'docs/architecture/reviews/v3-protocol-semantic-field-matrix.yml',
    'docs/architecture/wiki/html/v3-protocol-semantic-field-matrix.html',
    'docs/goals/v3-protocol-semantic-field-gap-closeout-plan.md',
    'scripts/architecture/render-v3-protocol-semantic-field-matrix.mjs',
    'Text truth for the audit lives in docs/architecture/reviews/v3-protocol-semantic-matrix-review.md',
    'build_v3_chat_canonical_request_from_responses_payload',
    'project_v3_responses_arguments_to_openai_chat_wire',
    'All inbound protocols decode into Chat canonical plus registered payload extensions',
    'reasoning_policy_system_marker',
    'execute_v3_responses_relay_runtime_inner',
    'build_v3_openai_chat_standard_request_from_chat_canonical',
    'build_provider_req_compat_06_from_v3_hub_req_outbound_07',
  ]],
  [paths.mainlineMap, text.mainlineMap, [
    'chain_id: v3.protocol_conversion_field_parity',
    'binding_kind: protocol_field_parity_test_over_existing_relay_chain',
    'v3-protocol-field-parity-responses-chat-req-01',
    'v3-protocol-field-parity-responses-chat-malformed-arguments-project-01',
    'v3-protocol-field-parity-responses-anthropic-req-01',
    'v3-protocol-field-parity-openai-chat-same-protocol-01',
    'Source wire is decoded to Chat canonical plus registered payload extensions before Chat Process',
    'design_conformance: pending',
  ]],
  [paths.verificationMap, text.verificationMap, [
    'feature_id: v3.protocol_conversion_field_parity',
    'Responses request to OpenAI Chat provider wire maps max_output_tokens to max_completion_tokens and preserves OpenAI Chat data-plane metadata/stop',
    'Valid Responses function-call argument JSON remains unchanged on OpenAI Chat wire',
    'Paired and unpaired malformed Responses function-call argument text is preserved exactly at the adjacent OpenAI Chat field projector without JSON-string rewrapping, MetadataCenter reconstruction, provider failure, or reselect',
    'Anthropic request thinking.type, thinking.budget_tokens, and thinking.display decode into separate registered Chat fields',
    'Responses reasoning.effort reaches Anthropic `output_config.effort` only for the exact shared value domain',
    'Responses reasoning.summary, reasoning.context, and reasoning.mode remain separate Chat payload extensions',
    'responses_openai_chat_field_parity_paired_malformed_arguments_preserve_exact_string_without_reselect',
    'responses_openai_chat_field_parity_unpaired_malformed_arguments_preserve_exact_string_without_reselect',
    'npm run render:v3-protocol-semantic-field-matrix',
    'npm run test:v3-protocol-conversion-field-parity',
    'docs/goals/v3-protocol-semantic-field-gap-closeout-plan.md',
  ]],
  [paths.resourceMap, text.resourceMap, [
    'resource_id: v3.protocol_conversion.field_parity_contract',
    'owner_feature_id: v3.protocol_conversion_field_parity',
    'resource_kind: verification_manifest',
    'docs/architecture/reviews/v3-protocol-semantic-field-matrix.yml',
    'docs/goals/v3-protocol-semantic-field-gap-closeout-plan.md',
  ]],
]) for (const phrase of phrases) requireText(body, owner, phrase);

const parityFeature = (functionMap?.features ?? []).find(
  (feature) => feature?.feature_id === 'v3.protocol_conversion_field_parity',
);
if (!parityFeature) {
  failures.push(`${paths.functionMap}: missing v3.protocol_conversion_field_parity feature`);
} else {
  if (!(parityFeature.entry_symbols ?? []).includes('execute_v3_responses_relay_runtime_inner')) {
    failures.push(`${paths.functionMap}: protocol parity runtime entry must be execute_v3_responses_relay_runtime_inner`);
  }
  if (!(parityFeature.entry_symbols ?? []).includes('project_v3_responses_arguments_to_openai_chat_wire')) {
    failures.push(`${paths.functionMap}: malformed-arguments projection helper must be registered as the adjacent codec owner`);
  }
  if ((parityFeature.mainline_bindings ?? []).some((entry) => String(entry).includes('responses-chat-req-negative'))) {
    failures.push(`${paths.functionMap}: projectable malformed arguments must not retain a negative/error mainline binding`);
  }
}

const parityChain = (mainlineMap?.chains ?? []).find(
  (chain) => chain?.chain_id === 'v3.protocol_conversion_field_parity',
);
const malformedArgumentsEdge = (parityChain?.edges ?? []).find(
  (edge) => edge?.step_id === 'v3-protocol-field-parity-responses-chat-malformed-arguments-project-01',
);
for (const [key, expected] of [
  ['from_node', 'ProviderReqCompat06ProviderCompat'],
  ['to_node', 'V3ProviderReqOutbound08WirePayload'],
  ['caller_symbol', 'build_v3_openai_chat_assistant_tool_call_message'],
  ['caller_file', paths.responsesOpenaiCodec],
  ['callee_symbol', 'project_v3_responses_arguments_to_openai_chat_wire'],
  ['callee_file', paths.responsesOpenaiCodec],
]) {
  if (malformedArgumentsEdge?.[key] !== expected) {
    failures.push(`${paths.mainlineMap}: malformed-arguments runtime edge ${key} must be ${expected}`);
  }
}
if ((malformedArgumentsEdge?.resource_flow?.side_channel_writes ?? []).length !== 0) {
  failures.push(`${paths.mainlineMap}: malformed-arguments field projector must not claim error/control side-channel writes`);
}
if ((parityChain?.edges ?? []).some((edge) => String(edge?.step_id).includes('responses-chat-req-negative'))) {
  failures.push(`${paths.mainlineMap}: projectable malformed arguments must not retain an Error05/negative parity edge`);
}

const providerActionGateChain = (mainlineMap?.chains ?? []).find(
  (chain) => chain?.chain_id === 'v3.provider_action_gate.mainline',
);
const providerCompatErrorEdge = (providerActionGateChain?.edges ?? []).find(
  (edge) => edge?.step_id === 'v3-provider-action-gate-01',
);
for (const [key, expected] of [
  ['from_node', 'ProviderReqCompat06ProviderCompat'],
  ['to_node', 'V3Error05ExecutionDecision'],
  ['caller_symbol', 'execute_v3_responses_relay_runtime_inner'],
  ['caller_file', paths.responsesRuntime],
  ['callee_symbol', 'handle_v3_responses_relay_provider_failure'],
  ['callee_file', paths.responsesRuntime],
]) {
  if (providerCompatErrorEdge?.[key] !== expected) {
    failures.push(`${paths.mainlineMap}: ProviderReqCompat06 typed failure edge ${key} must be ${expected}`);
  }
}
for (const forbiddenStepId of [
  'v3-protocol-field-parity-responses-direct-kernel-01',
  'v3-protocol-field-parity-responses-direct-wire-01',
]) {
  if ((parityChain?.edges ?? []).some((edge) => edge?.step_id === forbiddenStepId)) {
    failures.push(`${paths.mainlineMap}: ${forbiddenStepId} must not duplicate existing Direct production mainline edges`);
  }
}
const directMainlineChain = (mainlineMap?.chains ?? []).find(
  (chain) => chain?.chain_id === 'v3.responses_direct.required_mainline',
);
for (const [stepId, expectations] of Object.entries({
  'v3-rd-09-direct-policy': {
    from_node: 'V3Execution11ProtocolDecision',
    to_node: 'V3ResponsesDirect11Policy',
    caller_symbol: 'execute_v3_responses_direct_runtime_kernel',
    caller_file: 'v3/crates/routecodex-v3-runtime/src/kernel.rs',
    callee_symbol: 'responses_direct_route_hook',
    callee_file: 'v3/crates/routecodex-v3-runtime/src/hooks.rs',
    owner_feature_id: 'v3.responses_direct_mvp_architecture',
  },
  'v3-rd-10': {
    from_node: 'V3ResponsesDirect11Policy',
    to_node: 'V3Provider12ResponsesWirePayload',
    caller_symbol: 'responses_direct_request_projection_hook',
    caller_file: 'v3/crates/routecodex-v3-runtime/src/hooks.rs',
    callee_symbol: 'build_v3_provider_12_responses_wire_payload',
    callee_file: 'v3/crates/routecodex-v3-provider-responses/src/wire.rs',
    owner_feature_id: 'v3.responses_provider_runtime',
  },
})) {
  const edge = (directMainlineChain?.edges ?? []).find((candidate) => candidate?.step_id === stepId);
  if (!edge) {
    failures.push(`${paths.mainlineMap}: missing existing Direct mainline edge ${stepId}`);
    continue;
  }
  for (const [key, expected] of Object.entries(expectations)) {
    if (edge?.[key] !== expected) {
      failures.push(`${paths.mainlineMap}: ${stepId} ${key} must be ${expected}`);
    }
  }
}

const parityVerification = (verificationMap?.features ?? []).find(
  (feature) => feature?.feature_id === 'v3.protocol_conversion_field_parity',
);
if (!(parityVerification?.required_blackbox ?? []).some(
  (entry) => String(entry).includes('responses_openai_chat_field_parity_paired_malformed_arguments_preserve_exact_string_without_reselect'),
)) {
  failures.push(`${paths.verificationMap}: paired malformed-arguments runtime test must be registered under required_blackbox`);
}
if (!(parityVerification?.required_blackbox ?? []).some(
  (entry) => String(entry).includes('responses_openai_chat_field_parity_unpaired_malformed_arguments_preserve_exact_string_without_reselect'),
)) {
  failures.push(`${paths.verificationMap}: unpaired malformed-arguments runtime test must be registered under required_blackbox`);
}
for (const testSymbol of [
  'responses_malformed_function_call_arguments_keep_pair_with_reversible_anthropic_input',
  'chat_malformed_tool_call_arguments_keep_pair_with_reversible_anthropic_input',
]) {
  if (!(parityVerification?.required_blackbox ?? []).some((entry) => String(entry).includes(testSymbol))) {
    failures.push(`${paths.verificationMap}: Anthropic malformed-arguments runtime test ${testSymbol} must be registered under required_blackbox`);
  }
}
if (!(parityVerification?.required_blackbox ?? []).some(
  (entry) => String(entry).includes('responses_openai_chat_field_parity_direct_kernel_preserves_responses_input_include_and_tool_history'),
)) {
  failures.push(`${paths.verificationMap}: production Direct kernel parity test must be registered under required_blackbox`);
}
for (const phrase of [
  'v3/crates/routecodex-v3-runtime/tests/responses_direct_tool_passthrough.rs',
  'Responses Direct kernel preserves same-protocol Responses input/include/tool history',
  'existing Direct mainline edges `v3-rd-09-direct-policy` and `v3-rd-10`',
]) requireText(text.verificationMap, `${paths.verificationMap}::v3.protocol_conversion_field_parity`, phrase);

const parityFeatureBlock = featureBlock(text.functionMap, 'feature_id: v3.protocol_conversion_field_parity');
for (const phrase of [
  'v3/crates/routecodex-v3-runtime/tests/responses_direct_tool_passthrough.rs',
  'responses_openai_chat_field_parity_direct_kernel_preserves_responses_input_include_and_tool_history',
]) requireText(parityFeatureBlock, `${paths.functionMap}::v3.protocol_conversion_field_parity`, phrase);
for (const phrase of [
  'v3/crates/routecodex-v3-provider-responses/src/wire.rs',
  'execute_v3_responses_direct_runtime_kernel_with_continuation',
  'execute_v3_responses_direct_runtime_kernel_core',
  'responses_direct_request_projection_hook',
  'build_v3_provider_12_responses_wire_payload',
  'v3-protocol-field-parity-responses-direct-kernel-01',
  'v3-protocol-field-parity-responses-direct-wire-01',
]) {
  if (parityFeatureBlock.includes(phrase)) {
    failures.push(`${paths.functionMap}::v3.protocol_conversion_field_parity must not claim Direct production owner phrase ${phrase}`);
  }
}
const allowedBlock = sectionSlice(parityFeatureBlock, 'allowed_paths:', 'forbidden_paths:');
forbid(allowedBlock, `${paths.functionMap}::v3.protocol_conversion_field_parity.allowed_paths`, [
  /(^|\n)\s*-\s*src(\/|\n|$)/,
  /(^|\n)\s*-\s*sharedmodule(\/|\n|$)/,
  /MetadataCenter|metadata_center/,
  /servertool_hooks\.rs/,
  /routecodex-v3-server\/src\/lib\.rs/,
  /routecodex-v3-provider-responses/,
]);

for (const phrase of [
  'V3 protocol semantic normalization matrix review',
  '`client_metadata` must first exist as a Chat payload extension',
  'Gemini still needs clearer semantic ownership',
  'Source field inventory',
  'Canonical textual truth for the field-matrix audit',
  'Audited status legend and counts',
  '`extension_declared` | 221',
  '`semantic_declared` | 50',
  '`source_inventory_only` | 0',
  '`shape_branch_gap` | 18',
  '`codec_shape_only` | 14',
  '`runtime_conformance_pending` | 1',
  '`partial` | 112',
  'Gap audit for runtime closeout',
  'gap.runtime_extension_declared',
  'gap.semantic_declared_runtime_closeout',
  'gap.partial_cross_protocol_semantics',
  'docs/goals/v3-protocol-semantic-field-gap-closeout-plan.md',
]) requireText(text.matrixReview, paths.matrixReview, phrase);
requireText(
  text.gapCloseoutPlan,
  paths.gapCloseoutPlan,
  'Anthropic metadata accepts exactly `user_id`',
);

for (const [source, sha256] of [
  ['openai_openapi', '9f65dd3582af1404d00d22f56d32595524a88459a98310afbb3cc488eb3fa270'],
  ['openai_sdk_responses', '32002f8ff62b00864440b8903d08edf36da9ef08aa80778fbc8d459498282eed'],
  ['openai_sdk_chat', '02a1db9721772b290ec266454403eea9b1a7dfaff10b314280087dca7949cfb6'],
  ['anthropic_sdk_messages', 'ea7531fdbcdd4443f3889eb330396a81391e11afed6a8750ca82d5e2ba535a9e'],
  ['gemini_discovery_v1beta', 'a8a87b426c1701b73d6100aff3efd8562289e6580157cab1db638a1af8f84edb'],
]) {
  if (fieldMatrix?.source_inventory?.sources?.[source]?.sha256 !== sha256) {
    failures.push(`${paths.fieldMatrix}: source_inventory.sources.${source}.sha256 must equal ${sha256}`);
  }
}

for (const [protocol, section, fields] of [
  ['responses', 'request_fields', ['request.background', 'request.context_management', 'request.conversation', 'request.prompt_cache_key', 'request.prompt_cache_options.ttl', 'request.text.format', 'request.top_logprobs']],
  ['responses', 'input_fields', ['request.input[].input_image.detail', 'request.input[].input_file.file_data', 'request.input[].reasoning.summary[].text', 'request.input[].function_call.call_id']],
  ['responses', 'response_fields', ['response.completed_at', 'response.prompt_cache_retention', 'response.safety_identifier', 'response.usage.total_tokens']],
  ['openai_chat', 'request_fields', ['request.audio.format', 'request.modalities', 'request.reasoning_effort', 'request.web_search_options', 'request.stream_options.include_usage']],
  ['openai_chat', 'message_fields', ['request.messages[].content[].input_audio.data', 'request.messages[].content[].file.file_id', 'request.messages[].tool_calls[].custom.input']],
  ['openai_chat', 'response_fields', ['response.choices[].message.audio', 'response.choices[].message.tool_calls', 'response.system_fingerprint', 'response.usage.total_tokens']],
  ['anthropic', 'request_fields', ['request.container', 'request.output_config.format.schema', 'request.thinking.budget_tokens', 'request.user_profile_id']],
  ['anthropic', 'content_block_fields', ['request.messages[].content[].tool_use.caller', 'request.messages[].content[].tool_result.is_error', 'request.messages[].content[].mid_conv_system.content']],
  ['anthropic', 'response_fields', ['response.container.id', 'response.stop_details', 'response.usage.cache_creation_input_tokens', 'response.usage.service_tier']],
  ['gemini', 'request_fields', ['request.systemInstruction.parts', 'request.serviceTier', 'request.store']],
  ['gemini', 'content_part_fields', ['request.contents[].parts[].thoughtSignature', 'request.contents[].parts[].toolCall.args', 'request.contents[].parts[].videoMetadata.fps']],
  ['gemini', 'tool_fields', ['request.toolConfig.functionCallingConfig.allowedFunctionNames', 'request.tools[].functionDeclarations[].parametersJsonSchema']],
  ['gemini', 'generation_config_fields', ['request.generationConfig.responseMimeType', 'request.generationConfig.responseModalities', 'request.generationConfig.thinkingConfig.thinkingBudget']],
  ['gemini', 'response_fields', ['response.modelVersion', 'response.responseId', 'response.usageMetadata.totalTokenCount', 'response.candidates[].groundingMetadata']],
]) requireInventoryFields(fieldMatrix, protocol, section, fields);
for (const [protocol, extension, fields] of [
  ['responses', 'prompt_cache', ['request.prompt_cache_key', 'request.prompt_cache_options.ttl']],
  ['openai_chat', 'audio_and_modalities', ['request.audio.format', 'request.modalities']],
  ['anthropic', 'container_and_output_config', ['request.output_config.format.schema', 'response.container.id']],
  ['gemini', 'tool_config', ['request.toolConfig.functionCallingConfig.allowedFunctionNames', 'request.tools[].functionDeclarations[].parametersJsonSchema']],
  ['gemini', 'generation_config', ['request.generationConfig.thinkingConfig.thinkingBudget', 'request.generationConfig.responseMimeType']],
]) requireExtensionFields(fieldMatrix, protocol, extension, fields);
requireClassificationCoversSourceInventory(fieldMatrix);
for (const [semantic, protocol, fields] of [
  ['content.audio', 'openai_chat', ['request.audio.format', 'response.choices[].message.audio']],
  ['tool.choice_and_parallelism', 'gemini', ['request.toolConfig.functionCallingConfig.mode', 'request.toolConfig.functionCallingConfig.allowedFunctionNames']],
  ['reasoning.request_effort', 'anthropic', ['request.output_config.effort']],
  ['reasoning.request_effort', 'gemini', ['request.generationConfig.thinkingConfig.thinkingLevel']],
  ['reasoning.request_display_policy', 'anthropic', ['request.thinking.display']],
  ['reasoning.request_include_thoughts', 'gemini', ['request.generationConfig.thinkingConfig.includeThoughts']],
  ['reasoning.request_budget_tokens', 'anthropic', ['request.thinking.budget_tokens']],
  ['reasoning.request_budget_tokens', 'gemini', ['request.generationConfig.thinkingConfig.thinkingBudget']],
  ['lifecycle.continuation_and_storage', 'responses', ['request.previous_response_id', 'request.context_management']],
  ['usage.tokens', 'gemini', ['response.usageMetadata.totalTokenCount', 'response.usageMetadata.thoughtsTokenCount']],
]) requireSemanticCorrespondence(fieldMatrix, semantic, protocol, fields);

requireMatrixProtocols(fieldMatrix, ['responses', 'openai_chat', 'anthropic', 'gemini']);
for (const [protocol, section, fields] of [
  ['responses', 'request_top_level_fields', ['model', 'input', 'instructions', 'previous_response_id', 'store', 'stream', 'tools', 'additional_tools', 'tool_choice', 'parallel_tool_calls', 'metadata', 'client_metadata', 'temperature', 'top_p', 'max_output_tokens', 'max_tokens', 'stop', 'response_format', 'reasoning', 'text', 'truncation', 'include', 'user', 'seed', 'logit_bias']],
  ['responses', 'input_item_fields', ['type', 'role', 'content', 'call_id', 'id', 'name', 'arguments', 'input', 'output', 'encrypted_content', 'summary', 'status']],
  ['responses', 'response_top_level_fields', ['id', 'object', 'created_at', 'model', 'status', 'output', 'output_text', 'finish_reason', 'usage', 'required_action', 'error']],
  ['openai_chat', 'request_top_level_fields', ['model', 'messages', 'tools', 'tool_choice', 'parallel_tool_calls', 'stream', 'stream_options', 'temperature', 'top_p', 'max_tokens', 'max_completion_tokens', 'stop', 'response_format', 'metadata', 'user', 'seed', 'logit_bias', 'n', 'logprobs', 'top_logprobs', 'frequency_penalty', 'presence_penalty']],
  ['openai_chat', 'message_fields', ['role', 'content', 'name', 'tool_calls', 'tool_call_id', 'function_call', 'refusal', 'reasoning_content', 'reasoning']],
  ['openai_chat', 'response_fields', ['id', 'object', 'created', 'model', 'choices', 'usage', 'system_fingerprint', 'service_tier']],
  ['anthropic', 'request_top_level_fields', ['model', 'messages', 'system', 'max_tokens', 'stop_sequences', 'stream', 'temperature', 'top_p', 'top_k', 'tools', 'tool_choice', 'metadata', 'thinking']],
  ['anthropic', 'content_block_fields', ['type', 'text', 'source', 'id', 'name', 'input', 'tool_use_id', 'content', 'thinking', 'signature', 'data']],
  ['anthropic', 'response_fields', ['id', 'type', 'role', 'content', 'model', 'stop_reason', 'stop_sequence', 'usage']],
  ['gemini', 'request_top_level_fields', ['contents', 'tools', 'toolConfig', 'safetySettings', 'systemInstruction', 'generationConfig', 'cachedContent', 'stream']],
  ['gemini', 'part_fields', ['text', 'inlineData', 'fileData', 'functionCall', 'functionResponse', 'executableCode', 'codeExecutionResult']],
  ['gemini', 'response_fields', ['candidates', 'promptFeedback', 'usageMetadata', 'finishReason', 'safetyRatings', 'citationMetadata', 'groundingMetadata', 'avgLogprobs', 'logprobsResult']],
]) requireMatrixFields(fieldMatrix, protocol, section, fields);
for (const semantic of ['model.identity', 'turn.messages', 'message.content_parts', 'tool.declarations', 'tool.calls', 'tool.result', 'reasoning.request_fields', 'reasoning.visible_content', 'usage.tokens', 'response.finish_reason']) {
  if (!fieldMatrix?.canonical_chat_semantics?.[semantic]) failures.push(`${paths.fieldMatrix}: missing canonical_chat_semantics.${semantic}`);
}
for (const gapId of ['gap.client_metadata.target_dependent', 'gap.gemini.field_coverage', 'gap.openai_chat.long_tail_fields', 'gap.responses.long_tail_fields']) {
  if (!fieldMatrix?.implementation_gaps?.some((gap) => gap?.id === gapId)) failures.push(`${paths.fieldMatrix}: missing implementation gap ${gapId}`);
}

requireNoPendingAuditStatus(fieldMatrix);
requireCanonicalExtensionRegistry(fieldMatrix);
requireAuditTruthContract(fieldMatrix);
requireManualSemanticTranslationGroups(fieldMatrix);
requireShapeBranchTransformContract(fieldMatrix);
requireGeminiToolConfigSemanticContract(fieldMatrix);
requireGeminiThinkingConfigSemanticContract(fieldMatrix);
requireGeminiGenerationConfigScalarSemanticContract(fieldMatrix);
requireExtendedOpenAiChatSemanticSuperset(fieldMatrix);

const expectedFieldMatrixHtml = renderV3ProtocolSemanticFieldMatrix();
if (text.fieldMatrixHtml !== expectedFieldMatrixHtml) {
  failures.push(`${paths.fieldMatrixHtml}: out of sync with ${paths.fieldMatrix}; run npm run render:v3-protocol-semantic-field-matrix`);
}
for (const token of [
  'data-review-surface="v3-protocol-semantic-field-matrix"',
  'audit-truth-contract',
  'canonical-textual-truth',
  'audited-status-counts',
  'gap-audit-closeout',
  'manual-semantic-translation-groups',
  'shape branch cases',
  'Standard Chat semantic meaning',
  'Responses semantic group',
  'Anthropic semantic group',
  'Gemini semantic group',
  'protocol-transform-groups',
  'chat-standard-request-response-extension',
          'chat-standard-request-response-extension',
        'OpenAI Chat field (native or extension)',
  'canonical semantic id',
  'Responses equivalent fields',
  'OpenAI Chat native / extended fields',
  'Anthropic equivalent fields',
  'Gemini equivalent fields',
  'owner / current_impl / gap',
  'OpenAI Chat superset rows',
  'OpenAI Chat field (native or extension)',
  'canonical semantic id',
  'Responses equivalent fields',
  'OpenAI Chat native / extended fields',
  'Anthropic equivalent fields',
  'Gemini equivalent fields',
  'OpenAI Chat superset rows',
    'noncanonical-protocol-fields-audit',
  'Non-canonical / isolated protocol fields',
  'without semantic row',
  'no Chat extension owner',
  'noncanonical-protocol-fields-audit',
  'Non-canonical / isolated protocol fields',
  'without semantic row',
  'no Chat extension owner',
  'semantic-correspondence',
  'protocol-specific-chat-extensions',
  'field-classification',
  'protocol-field-matrix',
  'implementation-gaps',
  'Source inventory / 下载字段清单证据',
  'Audit truth contract / 文本真相与 gap 审计',
  'Gap audit closeout categories',
  'OpenAI Chat',
  'Anthropic Messages',
  'Gemini',
  'AUTO-GENERATED from',
]) requireText(text.fieldMatrixHtml, paths.fieldMatrixHtml, token);
for (const token of [
  'export function renderV3ProtocolSemanticFieldMatrixHtml',
  'V3_PROTOCOL_SEMANTIC_FIELD_MATRIX_HTML_PATH',
  'renderAuditTruthContract',
  'audit-truth-contract',
  'audited-status-counts',
  'gap-audit-closeout',
  'renderManualSemanticTranslationGroups',
  'renderShapeBranchCases',
  'shape branch cases',
  'manual-semantic-translation-groups',
  'Standard Chat semantic meaning',
  'Responses semantic group',
  'Anthropic semantic group',
  'Gemini semantic group',
  'chat-standard-request-response-extension',
        'OpenAI Chat field (native or extension)',
  'canonical semantic id',
  'Responses equivalent fields',
  'OpenAI Chat native / extended fields',
  'Anthropic equivalent fields',
  'Gemini equivalent fields',
  'OpenAI Chat superset rows',
    'noncanonical-protocol-fields-audit',
  'Non-canonical / isolated protocol fields',
  'without semantic row',
  'no Chat extension owner',
  'semantic-correspondence',
  'protocol-specific-chat-extensions',
  'field-classification',
  'implementation-gaps',
]) requireText(text.fieldMatrixRenderer, paths.fieldMatrixRenderer, token);

const pkg = JSON.parse(text.packageJson);
for (const scriptName of [
  'render:v3-protocol-semantic-field-matrix',
  'test:v3-protocol-conversion-field-parity',
  'verify:v3-protocol-conversion-field-parity',
  'test:v3-protocol-conversion-field-parity-red-fixtures',
]) {
  if (!pkg.scripts?.[scriptName]) failures.push(`${paths.packageJson}: missing script ${scriptName}`);
}
const parityCiScript = String(pkg.scripts?.['verify:v3-protocol-conversion-field-parity-ci'] ?? '');
for (const command of [
  'npm run verify:v3-protocol-conversion-field-parity',
  'npm run test:v3-protocol-conversion-field-parity-red-fixtures',
  'npm run test:v3-protocol-conversion-field-parity',
]) {
  if (!parityCiScript.includes(command)) {
    failures.push(`${paths.packageJson}: verify:v3-protocol-conversion-field-parity-ci must include ${command}`);
  }
}
if (!String(text.v3ArchitectureCi ?? '').includes("'verify:v3-protocol-conversion-field-parity'")) {
  failures.push(`${paths.v3ArchitectureCi}: verify:v3-architecture-ci must run verify:v3-protocol-conversion-field-parity`);
}
if (pkg.scripts?.['render:v3-protocol-semantic-field-matrix'] !== 'node scripts/architecture/render-v3-protocol-semantic-field-matrix.mjs') {
  failures.push(`${paths.packageJson}: render:v3-protocol-semantic-field-matrix must run node scripts/architecture/render-v3-protocol-semantic-field-matrix.mjs`);
}
for (const scriptName of ['test:v3-protocol-conversion-field-parity', 'test:v3-anthropic-codec-characterization', 'test:v3-gemini-codec-characterization', 'verify:v3-cargo-fmt']) {
  if (!String(pkg.scripts?.[scriptName] ?? '').includes('+stable')) failures.push(`${paths.packageJson}: ${scriptName} must use +stable so the gate works without a global rustup default`);
}

if (failures.length) {
  console.error('[verify:v3-protocol-conversion-field-parity] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('[verify:v3-protocol-conversion-field-parity] ok');


function requireMatrixProtocols(matrix, protocols) {
  for (const protocol of protocols) {
    if (!matrix?.protocols?.[protocol]) failures.push(`${paths.fieldMatrix}: missing protocol ${protocol}`);
  }
}
function requireMatrixFields(matrix, protocol, section, fields) {
  const rows = matrix?.protocols?.[protocol]?.[section];
  if (!Array.isArray(rows)) {
    failures.push(`${paths.fieldMatrix}: missing ${protocol}.${section}`);
    return;
  }
  const actual = new Set(rows.map((row) => row?.field).filter(Boolean));
  for (const field of fields) {
    if (!actual.has(field)) failures.push(`${paths.fieldMatrix}: missing ${protocol}.${section}.${field}`);
  }
}
function requireInventoryFields(matrix, protocol, section, fields) {
  const rows = matrix?.source_inventory?.[protocol]?.[section];
  if (!Array.isArray(rows)) {
    failures.push(`${paths.fieldMatrix}: missing source_inventory.${protocol}.${section}`);
    return;
  }
  const actual = new Set(rows.filter(Boolean));
  for (const field of fields) {
    if (!actual.has(field)) failures.push(`${paths.fieldMatrix}: missing source_inventory.${protocol}.${section}.${field}`);
  }
}
function requireExtensionFields(matrix, protocol, extension, fields) {
  const rows = matrix?.protocol_specific_chat_extensions?.[protocol]?.[extension]?.field_paths;
  if (!Array.isArray(rows)) {
    failures.push(`${paths.fieldMatrix}: missing protocol_specific_chat_extensions.${protocol}.${extension}.field_paths`);
    return;
  }
  const actual = new Set(rows.filter(Boolean));
  for (const field of fields) {
    if (!actual.has(field)) failures.push(`${paths.fieldMatrix}: missing protocol_specific_chat_extensions.${protocol}.${extension}.${field}`);
  }
}
function requireClassificationCoversSourceInventory(matrix) {
  for (const protocol of ['responses', 'openai_chat', 'anthropic', 'gemini']) {
    const source = matrix?.source_inventory?.[protocol];
    const classified = matrix?.field_classification?.[protocol];
    if (!source || !classified) {
      failures.push(`${paths.fieldMatrix}: missing source/classification for ${protocol}`);
      continue;
    }
    const sourceFields = new Set();
    for (const rows of Object.values(source)) {
      if (Array.isArray(rows)) for (const row of rows) sourceFields.add(row);
    }
    const classificationBuckets = [
      'canonical_chat_fields',
      'protocol_specific_chat_extension_fields',
      'edge_only_fields',
      'unsupported_or_lossy_fields',
    ];
    const fieldSeen = new Map();
    for (const bucket of classificationBuckets) {
      const rows = classified?.[bucket];
      if (!Array.isArray(rows)) {
        failures.push(`${paths.fieldMatrix}: missing field_classification.${protocol}.${bucket}`);
        continue;
      }
      for (const row of rows) fieldSeen.set(row, (fieldSeen.get(row) ?? 0) + 1);
    }
    for (const row of sourceFields) {
      const count = fieldSeen.get(row) ?? 0;
      if (count !== 1) failures.push(`${paths.fieldMatrix}: ${protocol} source field ${row} classified ${count} times`);
    }
    for (const row of fieldSeen.keys()) {
      if (!sourceFields.has(row)) failures.push(`${paths.fieldMatrix}: ${protocol} classification field not in source_inventory: ${row}`);
    }
  }
}
function requireSemanticCorrespondence(matrix, semantic, protocol, fields) {
  const row = matrix?.semantic_correspondence?.[semantic];
  if (!row) {
    failures.push(`${paths.fieldMatrix}: missing semantic_correspondence.${semantic}`);
    return;
  }
  if (!row.canonical_path || !row.chat_extension || !row.current_impl) {
    failures.push(`${paths.fieldMatrix}: semantic_correspondence.${semantic} missing canonical_path/chat_extension/current_impl`);
  }
  const pathsForProtocol = row?.paths?.[protocol];
  if (!Array.isArray(pathsForProtocol)) {
    failures.push(`${paths.fieldMatrix}: missing semantic_correspondence.${semantic}.paths.${protocol}`);
    return;
  }
  const actual = new Set(pathsForProtocol);
  for (const field of fields) {
    if (!actual.has(field)) failures.push(`${paths.fieldMatrix}: missing semantic_correspondence.${semantic}.${protocol}.${field}`);
  }
}

function requireNoPendingAuditStatus(matrix) {
  const hits = [];
  walkCurrentImpl(matrix, [], (pathParts, value) => {
    if (value === 'pending_audit') hits.push(pathParts.join('.'));
  });
  if (hits.length) failures.push(`${paths.fieldMatrix}: current_impl must use precise audited statuses, not pending_audit (${hits.slice(0, 8).join(', ')})`);
  const sourceOnlyHits = [];
  walkCurrentImpl(matrix, [], (pathParts, value) => {
    if (value === 'source_inventory_only') sourceOnlyHits.push(pathParts.join('.'));
  });
  if (sourceOnlyHits.length) failures.push(`${paths.fieldMatrix}: current_impl=source_inventory_only is closed and must not reappear (${sourceOnlyHits.slice(0, 8).join(', ')})`);
}

function requireCanonicalExtensionRegistry(matrix) {
  const registry = matrix?.canonical_extension_registry;
  if (!Array.isArray(registry) || registry.length === 0) {
    failures.push(`${paths.fieldMatrix}: missing canonical_extension_registry for OpenAI Chat extension fields`);
    return;
  }
  const registryByField = new Map();
  for (const [index, row] of registry.entries()) {
    for (const key of ['field', 'semantic_id', 'direction', 'stratum', 'owner', 'current_impl', 'source_fields', 'projection_rule']) {
      if (row?.[key] == null) failures.push(`${paths.fieldMatrix}: canonical_extension_registry[${index}] missing ${key}`);
    }
    if (registryByField.has(row?.field)) failures.push(`${paths.fieldMatrix}: duplicate canonical_extension_registry field ${row?.field}`);
    registryByField.set(row?.field, row);
    if (!/^(request|response|edge)\.[A-Za-z0-9_\[\]\.]+$/u.test(row?.field ?? '')) {
      failures.push(`${paths.fieldMatrix}: canonical extension field must be top-level request/response/edge path: ${row?.field}`);
    }
    if (/^(request|response)\.(reasoning|generation|text)\./u.test(row?.field ?? '')) {
      failures.push(`${paths.fieldMatrix}: provider-shaped invented canonical extension hierarchy forbidden: ${row.field}`);
    }
    if (row?.field !== row?.semantic_id) failures.push(`${paths.fieldMatrix}: canonical extension semantic_id must equal field ${row?.field}`);
  }
  for (const row of matrix?.extended_openai_chat_semantic_superset?.fields ?? []) {
    if (row?.mapping_status !== 'extension_added') continue;
    const registered = registryByField.get(row.extended_openai_chat_field);
    if (!registered) {
      failures.push(`${paths.fieldMatrix}: extension field ${row.extended_openai_chat_field} missing canonical_extension_registry entry`);
      continue;
    }
    for (const key of ['semantic_id', 'direction', 'current_impl']) {
      if (registered[key] !== row[key]) failures.push(`${paths.fieldMatrix}: canonical_extension_registry.${row.extended_openai_chat_field}.${key} must match superset row`);
    }
  }
  for (const row of registry) {
    const superset = (matrix?.extended_openai_chat_semantic_superset?.fields ?? []).find((item) => item?.extended_openai_chat_field === row.field);
    if (!superset || superset.mapping_status !== 'extension_added') failures.push(`${paths.fieldMatrix}: canonical_extension_registry.${row.field} must correspond to an extension_added superset row`);
  }
}

function requireAuditTruthContract(matrix) {
  const contract = matrix?.audit_truth_contract;
  if (!contract) {
    failures.push(`${paths.fieldMatrix}: missing audit_truth_contract textual truth gate`);
    return;
  }
  for (const [key, expected] of [
    ['canonical_text_doc', paths.matrixReview],
    ['generated_review_surface', paths.fieldMatrixHtml],
    ['closeout_goal_doc', paths.gapCloseoutPlan],
    ['gate', 'npm run verify:v3-protocol-conversion-field-parity'],
    ['red_fixture_gate', 'npm run test:v3-protocol-conversion-field-parity-red-fixtures'],
  ]) {
    if (contract?.[key] !== expected) failures.push(`${paths.fieldMatrix}: audit_truth_contract.${key} must be ${expected}`);
  }
  for (const phrase of ['OpenAI Chat is the Chat Process base protocol', 'protocol-neutral request/response/edge extension fields', 'semantic meaning']) {
    if (!String(contract?.truth_statement ?? '').includes(phrase)) failures.push(`${paths.fieldMatrix}: audit_truth_contract.truth_statement missing ${phrase}`);
  }
  for (const forbidden of ['MetadataCenter', 'raw payload dump', 'SSE transport', 'server handler', 'provider transport']) {
    if (!(contract?.forbidden_truth_sources ?? []).includes(forbidden)) failures.push(`${paths.fieldMatrix}: audit_truth_contract.forbidden_truth_sources missing ${forbidden}`);
  }
  const requiredStatuses = [
    'covered',
    'covered_but_target_dependent',
    'runtime_conformance_pending',
    'partial',
    'extension_declared',
    'semantic_declared',
    'source_inventory_only',
    'shape_branch_gap',
    'codec_shape_only',
    'edge_only',
  ];
  for (const status of requiredStatuses) {
    if (!contract?.status_legend?.[status]) failures.push(`${paths.fieldMatrix}: audit_truth_contract.status_legend missing ${status}`);
  }
  const actualCounts = currentImplCounts(matrix);
  for (const status of requiredStatuses) {
    const expectedCount = actualCounts.get(status) ?? 0;
    const declared = contract?.audited_status_counts?.[status];
    if (declared !== expectedCount) failures.push(`${paths.fieldMatrix}: audit_truth_contract.audited_status_counts.${status} must equal current_impl count ${expectedCount}, got ${declared}`);
  }
  for (const status of Object.keys(contract?.audited_status_counts ?? {})) {
    if (!requiredStatuses.includes(status)) failures.push(`${paths.fieldMatrix}: audit_truth_contract.audited_status_counts has unknown status ${status}`);
  }
  const gaps = Array.isArray(contract?.gap_audit) ? contract.gap_audit : [];
  const byId = new Map(gaps.map((gap) => [gap?.gap_id, gap]));
  for (const [gapId, status, closeoutStatus] of [
    ['gap.client_metadata.target_dependent', 'runtime_conformance_pending', 'runtime_conformance_pending'],
    ['gap.runtime_extension_declared', 'extension_declared', 'needs_runtime_goal'],
    ['gap.semantic_declared_runtime_closeout', 'semantic_declared', 'needs_runtime_goal'],
    ['gap.partial_cross_protocol_semantics', 'partial', 'needs_runtime_goal'],
    ['gap.source_inventory_only', 'source_inventory_only', 'closed_as_semantic_declared'],
    ['gap.shape_branch_transform', 'shape_branch_gap', 'needs_red_tests'],
    ['gap.gemini_codec_shape_only', 'codec_shape_only', 'needs_runtime_goal'],
    ['gap.edge_only_transport_state', 'edge_only', 'no_business_runtime_closeout'],
  ]) {
    const gap = byId.get(gapId);
    if (!gap) {
      failures.push(`${paths.fieldMatrix}: audit_truth_contract.gap_audit missing ${gapId}`);
      continue;
    }
    if (!(gap?.affected_statuses ?? []).includes(status)) failures.push(`${paths.fieldMatrix}: ${gapId} must cover status ${status}`);
    const expectedCount = actualCounts.get(status) ?? 0;
    if (gap?.affected_count !== expectedCount) failures.push(`${paths.fieldMatrix}: ${gapId}.affected_count must equal ${expectedCount}`);
    if (gap?.closeout_status !== closeoutStatus) failures.push(`${paths.fieldMatrix}: ${gapId}.closeout_status must be ${closeoutStatus}`);
    for (const [key, minLength] of [['category', 5], ['evidence', 20], ['required_owner', 10], ['closeout_rule', 20]]) {
      if (!gap?.[key] || String(gap[key]).length < minLength) failures.push(`${paths.fieldMatrix}: ${gapId} missing descriptive ${key}`);
    }
  }
  for (const gap of matrix?.implementation_gaps ?? []) {
    if (!gap?.closeout_status || !gap?.required_gate) failures.push(`${paths.fieldMatrix}: implementation_gaps.${gap?.id ?? 'missing'} must include closeout_status and required_gate`);
  }
}

function currentImplCounts(matrix) {
  const counts = new Map();
  walkCurrentImpl(matrix, [], (_pathParts, value) => {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  });
  return counts;
}

function walkCurrentImpl(value, pathParts, visit) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkCurrentImpl(item, [...pathParts, `[${index}]`], visit));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'canonical_extension_registry') continue;
    if (key === 'current_impl') visit([...pathParts, key], child);
    else walkCurrentImpl(child, [...pathParts, key], visit);
  }
}

function requireManualSemanticTranslationGroups(matrix) {
  const groups = matrix?.chat_semantic_translation_groups;
  if (!Array.isArray(groups) || groups.length < 30) {
    failures.push(`${paths.fieldMatrix}: chat_semantic_translation_groups must contain hand-audited Chat-standard semantic groups`);
    return;
  }
  const byId = new Map();
  for (const [index, group] of groups.entries()) {
    for (const key of ['group_id', 'standard_chat_field', 'direction', 'standard_semantic_meaning', 'chat_shape_rule', 'protocol_mappings', 'current_impl', 'gap']) {
      if (group?.[key] == null) failures.push(`${paths.fieldMatrix}: chat_semantic_translation_groups[${index}] missing ${key}`);
    }
    if (byId.has(group?.group_id)) failures.push(`${paths.fieldMatrix}: duplicate chat_semantic_translation_groups group_id ${group?.group_id}`);
    byId.set(group?.group_id, group);
    if (String(group?.standard_semantic_meaning ?? '').length < 40) {
      failures.push(`${paths.fieldMatrix}: ${group?.group_id} must define the Chat semantic meaning, not only list fields`);
    }
    if (String(group?.chat_shape_rule ?? '').length < 40) {
      failures.push(`${paths.fieldMatrix}: ${group?.group_id} must define Chat shape/value transform rules`);
    }
    for (const protocol of ['responses', 'anthropic', 'gemini']) {
      const mapping = group?.protocol_mappings?.[protocol];
      if (!mapping) {
        failures.push(`${paths.fieldMatrix}: ${group?.group_id} missing protocol_mappings.${protocol}`);
        continue;
      }
      if (!Array.isArray(mapping.request_fields) || !Array.isArray(mapping.response_fields)) {
        failures.push(`${paths.fieldMatrix}: ${group?.group_id}.protocol_mappings.${protocol} must have request_fields and response_fields arrays`);
      }
      if (!mapping.transform || String(mapping.transform).length < 30) {
        failures.push(`${paths.fieldMatrix}: ${group?.group_id}.protocol_mappings.${protocol} missing manual transform`);
      }
    }
  }
  for (const id of [
    'turn.role',
    'content.text_string',
    'content.image_url',
    'content.inline_media_data',
    'content.media_mime_type',
    'tool.declaration',
    'tool.call.id',
    'tool.call.name',
    'tool.call.arguments',
    'tool.result.call_id',
    'tool.result.output',
    'tool.result.name',
    'tool.result.error_status',
    'response.finish_reason',
    'response.usage_tokens',
  ]) {
    if (!byId.has(id)) failures.push(`${paths.fieldMatrix}: missing manual semantic translation group ${id}`);
  }
  const manyToOne = groups.filter((group) => ['responses', 'anthropic', 'gemini'].some((protocol) => groupProtocolFields(group, protocol).length > 1));
  if (manyToOne.length < 12) failures.push(`${paths.fieldMatrix}: manual semantic groups must include many-to-one/one-to-many mappings; found only ${manyToOne.length}`);

  requireGroupFields(byId, 'tool.call.id', 'request.messages[].tool_calls[].id', {
    responses: ['request.input[].function_call.call_id'],
    anthropic: ['request.messages[].content[].tool_use.id'],
    gemini: ['request.contents[].parts[].functionCall.id'],
  });
  forbidGroupFields(byId, 'tool.call.id', {
    responses: ['request.input[].function_call.arguments', 'request.input[].function_call.name'],
    anthropic: ['request.messages[].content[].tool_use.input', 'request.messages[].content[].tool_use.name'],
    gemini: ['request.contents[].parts[].functionCall.args', 'request.contents[].parts[].functionCall.name'],
  });
  requireGroupFields(byId, 'tool.call.name', 'request.messages[].tool_calls[].function.name', {
    responses: ['request.input[].function_call.name'],
    anthropic: ['request.messages[].content[].tool_use.name'],
    gemini: ['request.contents[].parts[].functionCall.name'],
  });
  requireGroupFields(byId, 'tool.call.arguments', 'request.messages[].tool_calls[].function.arguments', {
    responses: ['request.input[].function_call.arguments'],
    anthropic: ['request.messages[].content[].tool_use.input'],
    gemini: ['request.contents[].parts[].functionCall.args'],
  });
  requireGroupFields(byId, 'tool.result.call_id', 'request.messages[].tool_call_id', {
    responses: ['request.input[].function_call_output.call_id'],
    anthropic: ['request.messages[].content[].tool_result.tool_use_id'],
    gemini: ['request.contents[].parts[].functionResponse.id'],
  });
  forbidGroupFields(byId, 'tool.result.call_id', {
    responses: ['request.input[].function_call_output.output'],
    anthropic: ['request.messages[].content[].tool_result.content', 'request.messages[].content[].tool_result.is_error'],
    gemini: ['request.contents[].parts[].functionResponse.name', 'request.contents[].parts[].functionResponse.response'],
  });
  requireGroupFields(byId, 'tool.result.output', 'request.messages[].tool_result.output', {
    responses: ['request.input[].function_call_output.output'],
    anthropic: ['request.messages[].content[].tool_result.content'],
    gemini: ['request.contents[].parts[].functionResponse.response'],
  });
  requireGroupFields(byId, 'tool.result.name', 'request.messages[].tool_result.name', {
    gemini: ['request.contents[].parts[].functionResponse.name'],
  });
  requireGroupFields(byId, 'tool.result.error_status', 'request.messages[].tool_result.is_error', {
    anthropic: ['request.messages[].content[].tool_result.is_error'],
  });
  requireGroupFields(byId, 'content.image_url', 'request.messages[].content[].image_url.url', {
    responses: ['request.input[].input_image.image_url'],
  });
  forbidGroupFields(byId, 'content.image_url', {
    responses: ['request.input[].input_image.file_id', 'request.input[].input_image.detail'],
    gemini: ['request.contents[].parts[].inlineData.data', 'request.contents[].parts[].inlineData.mimeType', 'request.contents[].parts[].fileData.fileUri'],
  });
  requireGroupFields(byId, 'content.media_mime_type', 'request.messages[].content[].media.mime_type', {
    gemini: ['request.contents[].parts[].inlineData.mimeType', 'request.contents[].parts[].fileData.mimeType'],
  });
  requireGroupFields(byId, 'content.inline_media_data', 'request.messages[].content[].media.inline_data', {
    gemini: ['request.contents[].parts[].inlineData.data'],
  });

  requireSupersetRowFields(matrix, 'request.messages[].tool_calls[].id', {
    responses: ['request.input[].function_call.call_id'],
    anthropic: ['request.messages[].content[].tool_use.id'],
    gemini: ['request.contents[].parts[].functionCall.id'],
  });
  forbidSupersetRowFields(matrix, 'request.messages[].tool_calls[].id', {
    responses: ['request.input[].function_call.arguments', 'request.input[].function_call.name'],
    anthropic: ['request.messages[].content[].tool_use.input', 'request.messages[].content[].tool_use.name'],
    gemini: ['request.contents[].parts[].functionCall.args', 'request.contents[].parts[].functionCall.name'],
  });
  requireSupersetRowFields(matrix, 'request.messages[].tool_calls[].function.arguments', {
    responses: ['request.input[].function_call.arguments'],
    anthropic: ['request.messages[].content[].tool_use.input'],
    gemini: ['request.contents[].parts[].functionCall.args'],
  });
  requireSupersetRowFields(matrix, 'request.messages[].tool_result.output', {
    responses: ['request.input[].function_call_output.output'],
    anthropic: ['request.messages[].content[].tool_result.content'],
    gemini: ['request.contents[].parts[].functionResponse.response'],
  });
  requireSupersetRowFields(matrix, 'request.messages[].tool_result.name', {
    gemini: ['request.contents[].parts[].functionResponse.name'],
  });
  requireSupersetRowFields(matrix, 'request.messages[].content[].media.mime_type', {
    gemini: ['request.contents[].parts[].inlineData.mimeType'],
  });
  forbidSupersetRowFields(matrix, 'request.messages[].content[].image_url.url', {
    responses: ['request.input[].input_image.file_id', 'request.input[].input_image.detail'],
    gemini: ['request.contents[].parts[].inlineData.data', 'request.contents[].parts[].inlineData.mimeType', 'request.contents[].parts[].fileData.fileUri'],
  });
}

function requireShapeBranchTransformContract(matrix) {
  const groups = matrix?.chat_semantic_translation_groups;
  if (!Array.isArray(groups)) return;
  const shapeGroups = groups.filter((group) => group?.current_impl === 'shape_branch_gap');
  if (shapeGroups.length !== 6) {
    failures.push(`${paths.fieldMatrix}: gap.shape_branch_transform must be represented by 6 manual shape_branch_gap groups, got ${shapeGroups.length}`);
  }
  const allowedOwnerFiles = new Set([
    paths.responsesOpenaiCodec,
    paths.requestOutboundFormat,
    paths.anthropicCodec,
    'v3/crates/routecodex-v3-runtime/src/hub_v1/gemini_codec.rs',
  ]);
  const requiredGroups = {
    'content.image_url': {
      positive: ['anthropic', 'responses'],
      negative: ['anthropic', 'gemini'],
      target: 'request.messages[].content[].image_url.url',
      forbiddenTokens: ['inlineData.mimeType', 'fileData.fileUri', 'base64'],
    },
    'content.inline_media_data': {
      positive: ['anthropic', 'gemini'],
      negative: ['anthropic', 'gemini'],
      target: 'request.messages[].content[].media.inline_data',
      forbiddenTokens: ['image.source.type == "url"', 'inlineData.mimeType'],
    },
    'content.media_mime_type': {
      positive: ['anthropic', 'gemini'],
      negative: ['anthropic', 'gemini'],
      target: 'request.messages[].content[].media.mime_type',
      forbiddenTokens: ['source.data', 'fileData.fileUri'],
    },
    'content.file_id': {
      positive: ['responses'],
      negative: ['responses', 'gemini'],
      target: 'request.messages[].content[].file.file_id',
      forbiddenTokens: ['file_data', 'file_url', 'fileData.fileUri'],
    },
    'content.file_data': {
      positive: ['anthropic', 'responses'],
      negative: ['responses', 'gemini'],
      target: 'request.messages[].content[].file.file_data',
      forbiddenTokens: ['file_id', 'file_url', 'inlineData.data without file-kind evidence'],
    },
    'content.file_uri': {
      positive: ['responses', 'gemini'],
      negative: ['responses', 'gemini'],
      target: 'request.messages[].content[].file.file_url',
      forbiddenTokens: ['input_image.image_url', 'inlineData.data'],
    },
  };
  const byId = new Map(groups.map((group) => [group?.group_id, group]));
  for (const [groupId, contract] of Object.entries(requiredGroups)) {
    const group = byId.get(groupId);
    if (!group) {
      failures.push(`${paths.fieldMatrix}: missing shape branch group ${groupId}`);
      continue;
    }
    if (group.current_impl !== 'shape_branch_gap') {
      failures.push(`${paths.fieldMatrix}: ${groupId} must remain shape_branch_gap until runtime branch tests close it`);
    }
    const cases = group?.shape_branch_cases;
    if (!cases) {
      failures.push(`${paths.fieldMatrix}: ${groupId} missing shape_branch_cases positive/negative contract`);
      continue;
    }
    const positive = Array.isArray(cases.positive) ? cases.positive : [];
    const negative = Array.isArray(cases.negative) ? cases.negative : [];
    requireShapeCaseProtocols(groupId, 'positive', positive, contract.positive);
    requireShapeCaseProtocols(groupId, 'negative', negative, contract.negative);
    for (const item of positive) {
      requireShapeCaseFields(groupId, 'positive', item, allowedOwnerFiles);
      if (item?.maps_to !== contract.target) failures.push(`${paths.fieldMatrix}: ${groupId} positive case must map to ${contract.target}`);
    }
    for (const item of negative) {
      requireShapeCaseFields(groupId, 'negative', item, allowedOwnerFiles);
      if (item?.must_not_map_to !== contract.target) failures.push(`${paths.fieldMatrix}: ${groupId} negative case must forbid ${contract.target}`);
    }
    const negativeText = negative.map((item) => String(item?.forbidden_source ?? '')).join('\n');
    for (const token of contract.forbiddenTokens) {
      if (!negativeText.includes(token)) failures.push(`${paths.fieldMatrix}: ${groupId} shape_branch_cases.negative must lock forbidden token ${token}`);
    }
  }
}

function requireShapeCaseProtocols(groupId, kind, rows, protocols) {
  if (!Array.isArray(rows) || rows.length === 0) {
    failures.push(`${paths.fieldMatrix}: ${groupId} shape_branch_cases.${kind} must not be empty`);
    return;
  }
  const actual = new Set(rows.map((row) => row?.protocol));
  for (const protocol of protocols) {
    if (!actual.has(protocol)) failures.push(`${paths.fieldMatrix}: ${groupId} shape_branch_cases.${kind} missing ${protocol} branch`);
  }
}

function requireShapeCaseFields(groupId, kind, item, allowedOwnerFiles) {
  for (const key of ['protocol', 'owner_file', 'required_test']) {
    if (!item?.[key]) failures.push(`${paths.fieldMatrix}: ${groupId} shape_branch_cases.${kind} missing ${key}`);
  }
  const conditionKey = kind === 'positive' ? 'source_condition' : 'forbidden_source';
  const targetKey = kind === 'positive' ? 'maps_to' : 'must_not_map_to';
  if (!item?.[conditionKey] || String(item[conditionKey]).length < 12) {
    failures.push(`${paths.fieldMatrix}: ${groupId} shape_branch_cases.${kind} missing descriptive ${conditionKey}`);
  }
  if (!item?.[targetKey]) {
    failures.push(`${paths.fieldMatrix}: ${groupId} shape_branch_cases.${kind} missing ${targetKey}`);
  }
  if (item?.owner_file && !allowedOwnerFiles.has(item.owner_file)) {
    failures.push(`${paths.fieldMatrix}: ${groupId} shape branch owner_file must be adjacent Rust codec owner, got ${item.owner_file}`);
  }
  if (item?.required_test && !/^[a-z0-9_]+$/u.test(item.required_test)) {
    failures.push(`${paths.fieldMatrix}: ${groupId} shape branch required_test must be a concrete Rust test symbol, got ${item.required_test}`);
  }
  if (item?.protocol === 'anthropic' && item?.owner_file === paths.anthropicCodec) {
    for (const phrase of [
      'collect_v3_anthropic_request_shape_branch_semantics',
      'V3AnthropicChatShapeBranchSemantic',
      'request.messages[].content[].image.source.url',
      'request.messages[].content[].image.source.data',
      'request.messages[].content[].image.source.media_type',
      'ChatImageUrlUrl',
      'ChatInlineMediaData',
      'ChatMediaMimeType',
    ]) requireText(text.anthropicCodec, paths.anthropicCodec, phrase);
    requireNear(text.anthropicCodec, paths.anthropicCodec, '"request.messages[].content[].image.source.url"', 'ChatImageUrlUrl');
    requireNear(text.anthropicCodec, paths.anthropicCodec, '"request.messages[].content[].image.source.data"', 'ChatInlineMediaData');
    requireNear(text.anthropicCodec, paths.anthropicCodec, '"request.messages[].content[].image.source.media_type"', 'ChatMediaMimeType');
    forbidNear(text.anthropicCodec, paths.anthropicCodec, '"request.messages[].content[].image.source.url"', 'ChatInlineMediaData');
    forbidNear(text.anthropicCodec, paths.anthropicCodec, '"request.messages[].content[].image.source.data"', 'ChatMediaMimeType');
    if (item?.required_test) requireText(text.anthropicCodecTests, paths.anthropicCodecTests, item.required_test);
    requireText(text.mainlineMap, paths.mainlineMap, 'v3-protocol-anthropic-shape-branch-01');
    requireText(text.mainlineMap, paths.mainlineMap, 'collect_v3_anthropic_request_shape_branch_semantics');
    requireText(text.functionMap, paths.functionMap, 'collect_v3_anthropic_request_shape_branch_semantics');
    requireText(text.verificationMap, paths.verificationMap, 'collect_v3_anthropic_request_shape_branch_semantics');
  }
  if (item?.protocol === 'gemini' && item?.owner_file === paths.geminiCodec) {
    for (const phrase of [
      'collect_v3_gemini_request_shape_branch_semantics',
      'V3GeminiChatShapeBranchSemantic',
      'request.contents[].parts[].inlineData.data',
      'request.contents[].parts[].inlineData.mimeType',
      'request.contents[].parts[].fileData.mimeType',
      'request.contents[].parts[].fileData.fileUri',
    ]) requireText(text.geminiCodec, paths.geminiCodec, phrase);
    requireNear(text.geminiCodec, paths.geminiCodec, '"request.contents[].parts[].inlineData.data"', 'ChatInlineMediaData');
    requireNear(text.geminiCodec, paths.geminiCodec, '"request.contents[].parts[].inlineData.mimeType"', 'ChatMediaMimeType');
    requireNear(text.geminiCodec, paths.geminiCodec, '"request.contents[].parts[].fileData.mimeType"', 'ChatMediaMimeType');
    requireNear(text.geminiCodec, paths.geminiCodec, '"request.contents[].parts[].fileData.fileUri"', 'ChatFileFileUrl');
    forbidNear(text.geminiCodec, paths.geminiCodec, '"request.contents[].parts[].inlineData.data"', 'ChatImageUrlUrl');
    forbidNear(text.geminiCodec, paths.geminiCodec, '"request.contents[].parts[].inlineData.data"', 'ChatFileFileData');
    forbidNear(text.geminiCodec, paths.geminiCodec, '"request.contents[].parts[].fileData.fileUri"', 'ChatImageUrlUrl');
    forbidNear(text.geminiCodec, paths.geminiCodec, '"request.contents[].parts[].fileData.fileUri"', 'ChatFileFileId');
    if (item?.required_test) requireText(text.geminiTests, paths.geminiTests, item.required_test);
    requireText(text.mainlineMap, paths.mainlineMap, 'v3-protocol-gemini-shape-branch-01');
    requireText(text.mainlineMap, paths.mainlineMap, 'collect_v3_gemini_request_shape_branch_semantics');
    requireText(text.functionMap, paths.functionMap, 'collect_v3_gemini_request_shape_branch_semantics');
    requireText(text.verificationMap, paths.verificationMap, 'collect_v3_gemini_request_shape_branch_semantics');
  }
}

function requireGeminiToolConfigSemanticContract(matrix) {
  const groups = matrix?.chat_semantic_translation_groups ?? [];
  const byId = new Map(groups.map((group) => [group?.group_id, group]));
  const choice = byId.get('tool.choice');
  if (!choice) {
    failures.push(`${paths.fieldMatrix}: missing tool.choice semantic group`);
  } else {
    for (const field of ['request.tool_choice', 'request.tool_choice.allowed_function_names']) {
      if (!(choice.chat_fields ?? []).includes(field)) failures.push(`${paths.fieldMatrix}: tool.choice.chat_fields missing ${field}`);
    }
    for (const field of ['request.toolConfig.functionCallingConfig.mode', 'request.toolConfig.functionCallingConfig.allowedFunctionNames']) {
      if (!(choice.protocol_mappings?.gemini?.request_fields ?? []).includes(field)) failures.push(`${paths.fieldMatrix}: tool.choice Gemini mapping missing ${field}`);
    }
    if (!(choice.chat_extension_fields ?? []).includes('request.tool_choice.allowed_function_names')) {
      failures.push(`${paths.fieldMatrix}: tool.choice must expose request.tool_choice.allowed_function_names extension`);
    }
  }
  const parallel = byId.get('tool.parallelism');
  if (parallel) {
    if ((parallel.protocol_mappings?.gemini?.request_fields ?? []).includes('request.toolConfig.functionCallingConfig.allowedFunctionNames')) {
      failures.push(`${paths.fieldMatrix}: Gemini allowedFunctionNames must not collapse into tool.parallelism`);
    }
    if ((parallel.protocol_mappings?.gemini?.request_fields ?? []).includes('request.toolConfig.functionCallingConfig.mode')) {
      failures.push(`${paths.fieldMatrix}: Gemini mode is tool-choice policy and must not collapse into tool.parallelism`);
    }
    if (parallel.current_impl !== 'partial') failures.push(`${paths.fieldMatrix}: tool.parallelism remains partial until Gemini mode has an explicit boolean contract`);
  }

  const modeBucket = classificationBucketForField(matrix, 'gemini', 'request.toolConfig.functionCallingConfig.mode');
  const allowedBucket = classificationBucketForField(matrix, 'gemini', 'request.toolConfig.functionCallingConfig.allowedFunctionNames');
  if (modeBucket !== 'canonical_chat_fields') failures.push(`${paths.fieldMatrix}: Gemini toolConfig mode must stay canonical_chat_fields`);
  if (allowedBucket !== 'protocol_specific_chat_extension_fields') failures.push(`${paths.fieldMatrix}: Gemini allowedFunctionNames must be a protocol-specific Chat extension field`);
  const topLevelToolConfig = matrix?.protocols?.gemini?.request_top_level_fields?.find((row) => row?.field === 'toolConfig');
  if (topLevelToolConfig?.current_impl !== 'partial') failures.push(`${paths.fieldMatrix}: Gemini top-level toolConfig current_impl must be partial after functionCallingConfig source closeout`);

  const toolChoiceRow = supersetRowByField(matrix, 'request.tool_choice');
  if (toolChoiceRow) {
    const gemini = toolChoiceRow?.equivalent_fields?.gemini ?? [];
    if (!gemini.includes('request.toolConfig.functionCallingConfig.mode')) failures.push(`${paths.fieldMatrix}: request.tool_choice must map Gemini mode`);
    if (gemini.includes('request.toolConfig.functionCallingConfig.allowedFunctionNames')) failures.push(`${paths.fieldMatrix}: request.tool_choice must not collapse Gemini allowedFunctionNames`);
  }
  const allowedNamesRow = supersetRowByField(matrix, 'request.tool_choice.allowed_function_names');
  if (allowedNamesRow) {
    if (allowedNamesRow.mapping_status !== 'extension_added') failures.push(`${paths.fieldMatrix}: request.tool_choice.allowed_function_names must be extension_added`);
    if (allowedNamesRow.current_impl !== 'partial') failures.push(`${paths.fieldMatrix}: request.tool_choice.allowed_function_names current_impl must be partial until cross-protocol/live closeout`);
    const gemini = allowedNamesRow?.equivalent_fields?.gemini ?? [];
    if (!gemini.includes('request.toolConfig.functionCallingConfig.allowedFunctionNames')) failures.push(`${paths.fieldMatrix}: request.tool_choice.allowed_function_names must map Gemini allowedFunctionNames`);
    if (gemini.includes('request.toolConfig.functionCallingConfig.mode')) failures.push(`${paths.fieldMatrix}: request.tool_choice.allowed_function_names must not collapse Gemini mode`);
    const associations = new Set((allowedNamesRow.chat_extension_association ?? []).map((item) => item?.extension_id));
    if (!associations.has('tool_config')) failures.push(`${paths.fieldMatrix}: request.tool_choice.allowed_function_names must bind tool_config extension association`);
  }

  for (const phrase of [
    'collect_v3_gemini_request_tool_config_semantics',
    'V3GeminiChatToolConfigSemantic',
    'V3GeminiChatToolChoicePolicy',
    'V3GeminiToolConfigSemanticValue',
    'ToolConfigAllowedFunctionNameNotString',
    'request.toolConfig.functionCallingConfig.mode',
    'request.toolConfig.functionCallingConfig.allowedFunctionNames',
    'ChatToolChoicePolicy',
    'ChatToolChoiceAllowedFunctionNames',
  ]) requireText(text.geminiCodec, paths.geminiCodec, phrase);
  requireNear(text.geminiCodec, paths.geminiCodec, '"request.toolConfig.functionCallingConfig.mode"', 'ChatToolChoicePolicy');
  requireNear(text.geminiCodec, paths.geminiCodec, '"request.toolConfig.functionCallingConfig.allowedFunctionNames"', 'ChatToolChoiceAllowedFunctionNames');
  forbidNear(text.geminiCodec, paths.geminiCodec, '"request.toolConfig.functionCallingConfig.allowedFunctionNames"', 'ChatToolDeclarationName');
  forbidNear(text.geminiCodec, paths.geminiCodec, '"request.toolConfig.functionCallingConfig.mode"', 'ChatParallelToolCalls');
  for (const testSymbol of [
    'gemini_tool_config_mode_maps_to_chat_tool_choice_policy',
    'gemini_tool_config_allowed_function_names_maps_to_allowed_tool_choice_names',
    'gemini_tool_config_allowed_function_names_do_not_become_tool_declarations',
    'gemini_tool_config_mode_does_not_become_parallel_tool_calls_without_value_contract',
    'gemini_tool_config_malformed_allowed_function_names_fail_closed',
    'gemini_tool_config_semantics_do_not_mutate_provider_wire_payload',
  ]) requireText(text.geminiTests, paths.geminiTests, testSymbol);
  for (const [owner, body] of [
    [paths.mainlineMap, text.mainlineMap],
    [paths.functionMap, text.functionMap],
    [paths.verificationMap, text.verificationMap],
  ]) {
    for (const phrase of ['v3-protocol-gemini-tool-config-01', 'collect_v3_gemini_request_tool_config_semantics']) {
      requireText(body, owner, phrase);
    }
  }
}


function requireGeminiThinkingConfigSemanticContract(matrix) {
  const groups = matrix?.chat_semantic_translation_groups ?? [];
  const byId = new Map(groups.map((group) => [group?.group_id, group]));
  const effort = byId.get('reasoning.request_effort');
  if (effort) {
    const anthropic = new Set(effort.protocol_mappings?.anthropic?.request_fields ?? []);
    if (!anthropic.has('request.output_config.effort')) failures.push(`${paths.fieldMatrix}: reasoning.request_effort must map Anthropic output_config.effort`);
    for (const field of ['request.thinking.type', 'request.thinking.budget_tokens']) {
      if (anthropic.has(field)) failures.push(`${paths.fieldMatrix}: reasoning.request_effort must not collapse into Anthropic ${field}`);
    }
    const gemini = new Set(effort.protocol_mappings?.gemini?.request_fields ?? []);
    if (!gemini.has('request.generationConfig.thinkingConfig.thinkingLevel')) failures.push(`${paths.fieldMatrix}: reasoning.request_effort must map Gemini thinkingLevel`);
    for (const field of ['request.generationConfig.thinkingConfig.includeThoughts', 'request.generationConfig.thinkingConfig.thinkingBudget']) {
      if (gemini.has(field)) failures.push(`${paths.fieldMatrix}: reasoning.request_effort must not collapse Gemini ${field}`);
    }
    if ((effort.protocol_mappings?.gemini?.response_fields ?? []).includes('response.usageMetadata.thoughtsTokenCount')) {
      failures.push(`${paths.fieldMatrix}: reasoning.request_effort must not treat thoughtsTokenCount usage as request effort`);
    }
  }
  const include = byId.get('reasoning.request_include_thoughts');
  if (!include) failures.push(`${paths.fieldMatrix}: missing reasoning.request_include_thoughts semantic group`);
  else {
    if (!(include.chat_fields ?? []).includes('request.reasoning_include_thoughts')) failures.push(`${paths.fieldMatrix}: reasoning.request_include_thoughts missing request.reasoning_include_thoughts chat field`);
    const gemini = include.protocol_mappings?.gemini?.request_fields ?? [];
    if (!gemini.includes('request.generationConfig.thinkingConfig.includeThoughts')) failures.push(`${paths.fieldMatrix}: reasoning.request_include_thoughts must map Gemini includeThoughts`);
  }
  const budget = byId.get('reasoning.request_budget_tokens');
  if (!budget) failures.push(`${paths.fieldMatrix}: missing reasoning.request_budget_tokens semantic group`);
  else {
    if (!(budget.chat_fields ?? []).includes('request.reasoning_budget_tokens')) failures.push(`${paths.fieldMatrix}: reasoning.request_budget_tokens missing request.reasoning_budget_tokens chat field`);
    const gemini = budget.protocol_mappings?.gemini?.request_fields ?? [];
    if (!gemini.includes('request.generationConfig.thinkingConfig.thinkingBudget')) failures.push(`${paths.fieldMatrix}: reasoning.request_budget_tokens must map Gemini thinkingBudget`);
    if ((budget.protocol_mappings?.gemini?.request_fields ?? []).includes('request.generationConfig.maxOutputTokens')) failures.push(`${paths.fieldMatrix}: Gemini thinkingBudget must not collapse into maxOutputTokens`);
  }
  const mode = byId.get('reasoning.request_mode');
  if (!mode || !(mode.chat_fields ?? []).includes('request.reasoning_mode')) failures.push(`${paths.fieldMatrix}: missing independent reasoning.request_mode semantic group`);
  const context = byId.get('reasoning.request_context_policy');
  if ((context?.protocol_mappings?.responses?.request_fields ?? []).includes('request.reasoning.mode')) failures.push(`${paths.fieldMatrix}: reasoning mode must not collapse into context policy`);
  const display = byId.get('reasoning.request_display_policy');
  if (!display || !(display.protocol_mappings?.anthropic?.request_fields ?? []).includes('request.thinking.display')) failures.push(`${paths.fieldMatrix}: missing independent Anthropic reasoning display policy`);
  const summary = byId.get('reasoning.request_summary_policy');
  if ((summary?.protocol_mappings?.anthropic?.request_fields ?? []).includes('request.thinking.display')) failures.push(`${paths.fieldMatrix}: OpenAI summary policy must not collapse into Anthropic display policy`);
  for (const [field, expected, forbidden] of [
    ['request.reasoning_effort', ['request.generationConfig.thinkingConfig.thinkingLevel'], ['request.generationConfig.thinkingConfig.includeThoughts', 'request.generationConfig.thinkingConfig.thinkingBudget']],
    ['request.reasoning_include_thoughts', ['request.generationConfig.thinkingConfig.includeThoughts'], ['request.generationConfig.thinkingConfig.thinkingBudget', 'request.generationConfig.thinkingConfig.thinkingLevel']],
    ['request.reasoning_budget_tokens', ['request.generationConfig.thinkingConfig.thinkingBudget'], ['request.generationConfig.maxOutputTokens', 'response.usageMetadata.thoughtsTokenCount', 'request.generationConfig.thinkingConfig.includeThoughts']],
  ]) {
    const row = supersetRowByField(matrix, field);
    if (!row) continue;
    for (const source of expected) if (!(row.equivalent_fields?.gemini ?? []).includes(source)) failures.push(`${paths.fieldMatrix}: ${field} must map Gemini ${source}`);
    for (const source of forbidden) if ((row.equivalent_fields?.gemini ?? []).includes(source)) failures.push(`${paths.fieldMatrix}: ${field} must not collapse Gemini ${source}`);
    if (field !== 'request.reasoning_effort' && row.mapping_status !== 'extension_added') failures.push(`${paths.fieldMatrix}: ${field} must be extension_added`);
    if (field !== 'request.reasoning_effort' && row.current_impl !== 'partial') failures.push(`${paths.fieldMatrix}: ${field} current_impl must be partial after Gemini source closeout`);
  }
  for (const phrase of [
    'collect_v3_gemini_request_thinking_config_semantics',
    'V3GeminiChatThinkingConfigSemantic',
    'V3GeminiThinkingConfigSemanticValue',
    'ThinkingConfigBudgetNotInteger',
    'request.generationConfig.thinkingConfig.includeThoughts',
    'request.generationConfig.thinkingConfig.thinkingBudget',
    'request.generationConfig.thinkingConfig.thinkingLevel',
    'ChatReasoningIncludeThoughts',
    'ChatReasoningBudgetTokens',
    'ChatReasoningLevel',
  ]) requireText(text.geminiCodec, paths.geminiCodec, phrase);
  requireNear(text.geminiCodec, paths.geminiCodec, '"request.generationConfig.thinkingConfig.includeThoughts"', 'ChatReasoningIncludeThoughts');
  requireNear(text.geminiCodec, paths.geminiCodec, '"request.generationConfig.thinkingConfig.thinkingBudget"', 'ChatReasoningBudgetTokens');
  requireNear(text.geminiCodec, paths.geminiCodec, '"request.generationConfig.thinkingConfig.thinkingLevel"', 'ChatReasoningLevel');
  forbidNear(text.geminiCodec, paths.geminiCodec, '"request.generationConfig.thinkingConfig.thinkingBudget"', 'ChatMaxOutputTokens');
  forbidNear(text.geminiCodec, paths.geminiCodec, '"request.generationConfig.thinkingConfig.includeThoughts"', 'ChatResponseReasoningContent');
  forbidNear(text.geminiCodec, paths.geminiCodec, '"request.generationConfig.thinkingConfig.thinkingLevel"', 'ChatReasoningBudgetTokens');
  for (const testSymbol of [
    'gemini_thinking_config_include_thoughts_maps_to_reasoning_visibility_request',
    'gemini_thinking_config_budget_maps_to_reasoning_budget_request',
    'gemini_thinking_config_level_maps_to_reasoning_effort_level_request',
    'gemini_thinking_budget_does_not_become_max_output_tokens',
    'gemini_include_thoughts_does_not_become_response_reasoning_content',
    'gemini_thinking_level_does_not_collapse_to_numeric_budget',
    'gemini_thinking_config_malformed_fields_fail_closed',
    'gemini_thinking_config_semantics_do_not_mutate_provider_wire_payload',
  ]) requireText(text.geminiTests, paths.geminiTests, testSymbol);
  for (const [owner, body] of [[paths.mainlineMap, text.mainlineMap], [paths.functionMap, text.functionMap], [paths.verificationMap, text.verificationMap]]) {
    for (const phrase of ['v3-protocol-gemini-thinking-config-01', 'collect_v3_gemini_request_thinking_config_semantics']) requireText(body, owner, phrase);
  }
}


function requireGeminiGenerationConfigScalarSemanticContract(matrix) {
  for (const [field, expected, forbidden, status] of [
    ['request.temperature', ['request.generationConfig.temperature'], ['request.generationConfig.topP', 'request.generationConfig.topK'], 'covered'],
    ['request.top_p', ['request.generationConfig.topP'], ['request.generationConfig.temperature', 'request.generationConfig.topK'], 'covered'],
    ['request.top_k', ['request.generationConfig.topK'], ['request.generationConfig.topP'], 'partial'],
    ['request.max_completion_tokens', ['request.generationConfig.maxOutputTokens'], ['request.generationConfig.thinkingConfig.thinkingBudget', 'response.usageMetadata.thoughtsTokenCount'], 'covered'],
    ['request.stop', ['request.generationConfig.stopSequences'], ['response.candidates[].finishReason'], 'partial'],
    ['request.frequency_penalty', ['request.generationConfig.frequencyPenalty'], ['request.generationConfig.presencePenalty', 'request.generationConfig.logprobs', 'request.generationConfig.seed'], 'partial'],
    ['request.presence_penalty', ['request.generationConfig.presencePenalty'], ['request.generationConfig.frequencyPenalty', 'request.generationConfig.logprobs', 'request.generationConfig.seed'], 'partial'],
    ['request.logprobs', ['request.generationConfig.responseLogprobs'], ['request.generationConfig.logprobs'], 'partial'],
    ['request.top_logprobs', ['request.generationConfig.logprobs'], ['request.generationConfig.responseLogprobs'], 'partial'],
    ['request.seed', ['request.generationConfig.seed'], ['request.generationConfig.frequencyPenalty', 'request.generationConfig.logprobs'], 'partial'],
  ]) {
    const row = supersetRowByField(matrix, field);
    if (!row) {
      failures.push(`${paths.fieldMatrix}: missing ${field} superset row`);
      continue;
    }
    const gemini = row.equivalent_fields?.gemini ?? [];
    for (const source of expected) if (!gemini.includes(source)) failures.push(`${paths.fieldMatrix}: ${field} must map Gemini ${source}`);
    for (const source of forbidden) if (gemini.includes(source)) failures.push(`${paths.fieldMatrix}: ${field} must not collapse Gemini ${source}`);
    if (row.current_impl !== status) failures.push(`${paths.fieldMatrix}: ${field} current_impl must be ${status} after Gemini generationConfig scalar source closeout`);
  }
  for (const phrase of [
    'collect_v3_gemini_request_generation_config_scalar_semantics',
    'V3GeminiChatGenerationConfigScalarSemantic',
    'V3GeminiGenerationConfigScalarSemanticValue',
    'GenerationConfigScalarNotInteger',
    'GenerationConfigStopSequenceNotString',
    'request.generationConfig.temperature',
    'request.generationConfig.topP',
    'request.generationConfig.topK',
    'request.generationConfig.maxOutputTokens',
    'request.generationConfig.stopSequences',
    'request.generationConfig.frequencyPenalty',
    'request.generationConfig.presencePenalty',
    'request.generationConfig.responseLogprobs',
    'request.generationConfig.logprobs',
    'request.generationConfig.seed',
    'ChatTemperature',
    'ChatTopP',
    'ChatTopK',
    'ChatMaxCompletionTokens',
    'ChatStop',
    'ChatFrequencyPenalty',
    'ChatPresencePenalty',
    'ChatLogprobs',
    'ChatTopLogprobs',
    'ChatSeed',
  ]) requireText(text.geminiCodec, paths.geminiCodec, phrase);
  requireNear(text.geminiCodec, paths.geminiCodec, '"request.generationConfig.temperature"', 'ChatTemperature');
  requireNear(text.geminiCodec, paths.geminiCodec, '"request.generationConfig.topP"', 'ChatTopP');
  requireNear(text.geminiCodec, paths.geminiCodec, '"request.generationConfig.topK"', 'ChatTopK');
  requireNear(text.geminiCodec, paths.geminiCodec, '"request.generationConfig.maxOutputTokens"', 'ChatMaxCompletionTokens');
  requireNear(text.geminiCodec, paths.geminiCodec, '"request.generationConfig.stopSequences"', 'ChatStop');
  requireNear(text.geminiCodec, paths.geminiCodec, '"request.generationConfig.frequencyPenalty"', 'ChatFrequencyPenalty');
  requireNear(text.geminiCodec, paths.geminiCodec, '"request.generationConfig.presencePenalty"', 'ChatPresencePenalty');
  requireNear(text.geminiCodec, paths.geminiCodec, '"request.generationConfig.responseLogprobs"', 'ChatLogprobs');
  requireNear(text.geminiCodec, paths.geminiCodec, '"request.generationConfig.logprobs"', 'ChatTopLogprobs');
  requireNear(text.geminiCodec, paths.geminiCodec, '"request.generationConfig.seed"', 'ChatSeed');
  forbidNear(text.geminiCodec, paths.geminiCodec, '"request.generationConfig.topP"', 'ChatTopK');
  forbidNear(text.geminiCodec, paths.geminiCodec, '"request.generationConfig.topK"', 'ChatTopP');
  forbidNear(text.geminiCodec, paths.geminiCodec, '"request.generationConfig.maxOutputTokens"', 'ChatReasoningBudgetTokens');
  forbidNear(text.geminiCodec, paths.geminiCodec, '"request.generationConfig.stopSequences"', 'ChatFinishReason');
  forbidNear(text.geminiCodec, paths.geminiCodec, '"request.generationConfig.frequencyPenalty"', 'ChatPresencePenalty');
  forbidNear(text.geminiCodec, paths.geminiCodec, '"request.generationConfig.responseLogprobs"', 'ChatTopLogprobs');
  forbidNear(text.geminiCodec, paths.geminiCodec, '"request.generationConfig.logprobs"', 'ChatLogprobs');
  forbidNear(text.geminiCodec, paths.geminiCodec, '"request.generationConfig.seed"', 'ChatTopLogprobs');
  for (const testSymbol of [
    'gemini_generation_config_temperature_maps_to_chat_temperature',
    'gemini_generation_config_top_p_maps_to_chat_top_p',
    'gemini_generation_config_top_k_maps_to_chat_top_k_extension',
    'gemini_generation_config_max_output_tokens_maps_to_chat_max_completion_tokens',
    'gemini_generation_config_stop_sequences_maps_to_chat_stop',
    'gemini_generation_config_frequency_penalty_maps_to_chat_frequency_penalty',
    'gemini_generation_config_presence_penalty_maps_to_chat_presence_penalty',
    'gemini_generation_config_response_logprobs_maps_to_chat_logprobs_request',
    'gemini_generation_config_logprobs_maps_to_chat_top_logprobs_count',
    'gemini_generation_config_seed_maps_to_chat_seed',
    'gemini_generation_config_penalties_logprobs_and_seed_do_not_collapse',
    'gemini_generation_config_scalar_malformed_fields_fail_closed',
    'gemini_generation_config_scalar_semantics_do_not_mutate_provider_wire_payload',
  ]) requireText(text.geminiTests, paths.geminiTests, testSymbol);
  for (const [owner, body] of [[paths.mainlineMap, text.mainlineMap], [paths.functionMap, text.functionMap], [paths.verificationMap, text.verificationMap]]) {
    for (const phrase of ['v3-protocol-gemini-generation-config-scalar-01', 'collect_v3_gemini_request_generation_config_scalar_semantics']) requireText(body, owner, phrase);
  }
}

function groupProtocolFields(group, protocol) {
  const mapping = group?.protocol_mappings?.[protocol] ?? {};
  return [...(mapping.request_fields ?? []), ...(mapping.response_fields ?? [])];
}

function requireGroupFields(byId, groupId, standardChatField, expectedByProtocol) {
  const group = byId.get(groupId);
  if (!group) return;
  if (group.standard_chat_field !== standardChatField) {
    failures.push(`${paths.fieldMatrix}: ${groupId} must use standard_chat_field ${standardChatField}, got ${group.standard_chat_field}`);
  }
  for (const [protocol, fields] of Object.entries(expectedByProtocol)) {
    const actual = new Set(groupProtocolFields(group, protocol));
    for (const field of fields) {
      if (!actual.has(field)) failures.push(`${paths.fieldMatrix}: ${groupId} missing ${protocol} semantic field ${field}`);
    }
  }
}

function forbidGroupFields(byId, groupId, forbiddenByProtocol) {
  const group = byId.get(groupId);
  if (!group) return;
  for (const [protocol, fields] of Object.entries(forbiddenByProtocol)) {
    const actual = new Set(groupProtocolFields(group, protocol));
    for (const field of fields) {
      if (actual.has(field)) failures.push(`${paths.fieldMatrix}: ${groupId} must not collapse ${protocol}.${field}`);
    }
  }
}

function requireSupersetRowFields(matrix, standardChatField, expectedByProtocol) {
  const row = supersetRowByField(matrix, standardChatField);
  if (!row) return;
  for (const [protocol, fields] of Object.entries(expectedByProtocol)) {
    const actual = new Set(row?.equivalent_fields?.[protocol] ?? []);
    for (const field of fields) {
      if (!actual.has(field)) failures.push(`${paths.fieldMatrix}: superset ${standardChatField} missing ${protocol}.${field}`);
    }
  }
}

function forbidSupersetRowFields(matrix, standardChatField, forbiddenByProtocol) {
  const row = supersetRowByField(matrix, standardChatField);
  if (!row) return;
  for (const [protocol, fields] of Object.entries(forbiddenByProtocol)) {
    const actual = new Set(row?.equivalent_fields?.[protocol] ?? []);
    for (const field of fields) {
      if (actual.has(field)) failures.push(`${paths.fieldMatrix}: superset ${standardChatField} must not collapse ${protocol}.${field}`);
    }
  }
}

function supersetRowByField(matrix, standardChatField) {
  const row = (matrix?.extended_openai_chat_semantic_superset?.fields ?? []).find((candidate) => candidate?.extended_openai_chat_field === standardChatField);
  if (!row) failures.push(`${paths.fieldMatrix}: missing superset field ${standardChatField}`);
  return row;
}

function requireExtendedOpenAiChatSemanticSuperset(matrix) {
  const superset = matrix?.extended_openai_chat_semantic_superset;
  if (!superset) {
    failures.push(`${paths.fieldMatrix}: missing extended_openai_chat_semantic_superset`);
    return;
  }
  if (superset.standard_protocol !== 'openai_chat') {
    failures.push(`${paths.fieldMatrix}: extended_openai_chat_semantic_superset.standard_protocol must be openai_chat`);
  }
  for (const phrase of ['OpenAI Chat plus extension fields', 'all source_inventory fields', 'MetadataCenter/raw payload dump']) {
    if (!String(superset.contract ?? superset.coverage_rule ?? superset.duplicate_rule ?? '').includes(phrase) && !JSON.stringify(superset).includes(phrase)) {
      failures.push(`${paths.fieldMatrix}: extended_openai_chat_semantic_superset missing contract phrase ${phrase}`);
    }
  }
  const rows = superset.fields;
  if (!Array.isArray(rows) || rows.length < 100) {
    failures.push(`${paths.fieldMatrix}: extended_openai_chat_semantic_superset.fields must be a full source-field superset`);
    return;
  }
  const allowedStatuses = new Set(['mapped', 'extension_added', 'edge_only', 'unsupported_blocked']);
  const semanticIds = new Map();
  const extendedFields = new Map();
  const sourceCoverage = new Map();
  const openAiSourceFields = collectSourceInventoryFields(matrix, 'openai_chat');
  for (const [index, row] of rows.entries()) {
    for (const key of ['extended_openai_chat_field', 'semantic_id', 'direction', 'mapping_status', 'semantic_owner', 'current_impl', 'equivalent_fields']) {
      if (row?.[key] == null) failures.push(`${paths.fieldMatrix}: superset.fields[${index}] missing ${key}`);
    }
    if (!allowedStatuses.has(row?.mapping_status)) failures.push(`${paths.fieldMatrix}: superset.fields[${index}] invalid mapping_status ${row?.mapping_status}`);
    addUnique(semanticIds, row?.semantic_id, `duplicate semantic_id ${row?.semantic_id}`);
    addUnique(extendedFields, row?.extended_openai_chat_field, `duplicate extended_openai_chat_field ${row?.extended_openai_chat_field}`);
    if (row?.semantic_id !== row?.extended_openai_chat_field) {
      failures.push(`${paths.fieldMatrix}: canonical semantic_id must equal the OpenAI Chat field/extension path: ${row?.semantic_id} != ${row?.extended_openai_chat_field}`);
    }
    if (/^(chat_native|chat_extension)\./u.test(String(row?.semantic_id ?? ''))) {
      failures.push(`${paths.fieldMatrix}: canonical semantic_id must not use generated chat_native/chat_extension namespace: ${row?.semantic_id}`);
    }
    if (/MetadataCenter|metadata_center|raw_payload|raw payload dump/i.test(String(row?.semantic_owner ?? ''))) {
      failures.push(`${paths.fieldMatrix}: business semantic owner must not be MetadataCenter/raw payload dump: ${row?.semantic_id}`);
    }
    if (/chat\.extensions\.openai_chat/i.test(String(row?.semantic_owner ?? ''))) {
      failures.push(`${paths.fieldMatrix}: OpenAI Chat native/extension semantic owner must not use chat.extensions.openai_chat namespace: ${row?.semantic_id}`);
    }
    if (!/^(request|response|edge)\./u.test(String(row?.extended_openai_chat_field ?? ''))) {
      failures.push(`${paths.fieldMatrix}: extended OpenAI Chat field must be top-level request./response./edge. field: ${row?.extended_openai_chat_field}`);
    }
    if (/openai_chat\.ext|\.responses\.|\.anthropic\.|\.gemini\.|^responses\.|^anthropic\.|^gemini\./u.test(String(row?.extended_openai_chat_field ?? ''))) {
      failures.push(`${paths.fieldMatrix}: extended OpenAI Chat field must not contain source protocol namespace: ${row?.extended_openai_chat_field}`);
    }
    const openAiNativeFields = row?.equivalent_fields?.openai_chat ?? [];
    const mapsToOpenAiNative = Array.isArray(openAiNativeFields) && openAiNativeFields.includes(row?.extended_openai_chat_field);
    if (Array.isArray(openAiNativeFields) && openAiNativeFields.length > 0 && !mapsToOpenAiNative) {
      failures.push(`${paths.fieldMatrix}: OpenAI Chat native field must not be renamed: ${row?.semantic_id} uses ${row?.extended_openai_chat_field} but native fields are ${openAiNativeFields.join(', ')}`);
    }
    if (mapsToOpenAiNative && row?.mapping_status === 'extension_added') {
      failures.push(`${paths.fieldMatrix}: OpenAI Chat native field must be mapped, not extension_added: ${row?.extended_openai_chat_field}`);
    }
    if (!mapsToOpenAiNative && openAiSourceFields.has(row?.extended_openai_chat_field)) {
      failures.push(`${paths.fieldMatrix}: OpenAI Chat source field appears without exact native equivalent row: ${row?.extended_openai_chat_field}`);
    }
    if (!mapsToOpenAiNative && row?.mapping_status === 'mapped') {
      failures.push(`${paths.fieldMatrix}: added Chat extension field must not use mapping_status=mapped without native OpenAI Chat equivalent: ${row?.extended_openai_chat_field}`);
    }
    if (row?.mapping_status === 'extension_added' && !String(row?.semantic_owner ?? '').startsWith('chat.')) {
      failures.push(`${paths.fieldMatrix}: extension_added row must have chat.* owner: ${row?.semantic_id}`);
    }
    if (row?.mapping_status === 'edge_only' && !String(row?.semantic_owner ?? '').startsWith('edge.')) {
      failures.push(`${paths.fieldMatrix}: edge_only row must have edge.* owner: ${row?.semantic_id}`);
    }
    for (const protocol of ['responses', 'openai_chat', 'anthropic', 'gemini']) {
      const fields = row?.equivalent_fields?.[protocol];
      if (!Array.isArray(fields)) failures.push(`${paths.fieldMatrix}: ${row?.semantic_id}.equivalent_fields.${protocol} must be an array`);
      for (const field of fields ?? []) {
        const key = `${protocol}\u0000${field}`;
        if (!sourceCoverage.has(key)) sourceCoverage.set(key, []);
        sourceCoverage.get(key).push(row?.semantic_id);
      }
    }
  }
  for (const protocol of ['responses', 'openai_chat', 'anthropic', 'gemini']) {
    const sourceFields = collectSourceInventoryFields(matrix, protocol);
    const declaredCount = superset?.source_field_counts?.[protocol];
    if (declaredCount !== sourceFields.size) failures.push(`${paths.fieldMatrix}: source_field_counts.${protocol} must equal ${sourceFields.size}`);
    for (const field of sourceFields) {
      const key = `${protocol}\u0000${field}`;
      const hits = sourceCoverage.get(key) ?? [];
      if (hits.length !== 1) failures.push(`${paths.fieldMatrix}: source field ${protocol}.${field} mapped to superset ${hits.length} times (${hits.join(', ')})`);
      const bucket = classificationBucketForField(matrix, protocol, field);
      const row = rows.find((candidate) => candidate?.equivalent_fields?.[protocol]?.includes(field));
      if (!row) continue;
      if (row.source_classification) {
        const mapsToOpenAiNative = Array.isArray(row?.equivalent_fields?.openai_chat) && row.equivalent_fields.openai_chat.includes(row.extended_openai_chat_field);
        if (bucket === 'edge_only_fields' && row.mapping_status !== 'edge_only') failures.push(`${paths.fieldMatrix}: ${protocol}.${field} must be edge_only`);
        if (bucket === 'unsupported_or_lossy_fields' && row.mapping_status !== 'unsupported_blocked') failures.push(`${paths.fieldMatrix}: ${protocol}.${field} must be unsupported_blocked`);
        if (bucket === 'protocol_specific_chat_extension_fields' && !mapsToOpenAiNative && row.mapping_status !== 'extension_added') failures.push(`${paths.fieldMatrix}: ${protocol}.${field} must be extension_added when no OpenAI Chat native field exists`);
        const extensionIds = extensionIdsForField(matrix, protocol, field);
        if (protocol !== 'openai_chat' && extensionIds.length > 0) {
          const actualIds = new Set((row.chat_extension_association ?? []).map((item) => item?.extension_id).filter(Boolean));
          for (const extensionId of extensionIds) {
            if (!actualIds.has(extensionId)) failures.push(`${paths.fieldMatrix}: ${protocol}.${field} missing Chat extension association ${extensionId}`);
          }
        }
      }
    }
    for (const [key, hits] of sourceCoverage.entries()) {
      const [coveredProtocol, field] = key.split('\u0000');
      if (coveredProtocol === protocol && !sourceFields.has(field)) failures.push(`${paths.fieldMatrix}: superset maps unknown source field ${protocol}.${field}`);
    }
  }
  const extendedFieldSet = new Set(rows.map((row) => row?.extended_openai_chat_field));
  for (const field of collectSourceInventoryFields(matrix, 'openai_chat')) {
    if (!extendedFieldSet.has(field)) failures.push(`${paths.fieldMatrix}: every OpenAI Chat source field must appear unchanged as a Chat Process field: ${field}`);
  }
}

function addUnique(map, key, message) {
  if (!key) return;
  if (map.has(key)) failures.push(`${paths.fieldMatrix}: ${message}`);
  map.set(key, true);
}
function collectSourceInventoryFields(matrix, protocol) {
  const fields = new Set();
  for (const rows of Object.values(matrix?.source_inventory?.[protocol] ?? {})) {
    if (Array.isArray(rows)) for (const row of rows) fields.add(row);
  }
  return fields;
}
function extensionIdsForField(matrix, protocol, field) {
  const ids = [];
  for (const [extensionId, extension] of Object.entries(matrix?.protocol_specific_chat_extensions?.[protocol] ?? {})) {
    if ((extension?.field_paths ?? []).includes(field)) ids.push(extensionId);
  }
  return ids;
}

function classificationBucketForField(matrix, protocol, field) {
  for (const bucket of ['canonical_chat_fields', 'protocol_specific_chat_extension_fields', 'edge_only_fields', 'unsupported_or_lossy_fields']) {
    if ((matrix?.field_classification?.[protocol]?.[bucket] ?? []).includes(field)) return bucket;
  }
  return 'unclassified';
}

function requireText(source, owner, phrase) {
  if (!source.includes(phrase)) failures.push(`${owner}: missing ${phrase}`);
}
function requireNear(source, owner, anchor, phrase, window = 260) {
  const index = source.indexOf(anchor);
  if (index < 0) {
    failures.push(`${owner}: missing ${anchor}`);
    return;
  }
  const segment = source.slice(index, index + window);
  if (!segment.includes(phrase)) failures.push(`${owner}: ${anchor} must map near ${phrase}`);
}
function forbidNear(source, owner, anchor, phrase, window = 260) {
  const index = source.indexOf(anchor);
  if (index < 0) {
    failures.push(`${owner}: missing ${anchor}`);
    return;
  }
  const segment = source.slice(index, index + window);
  if (segment.includes(phrase)) failures.push(`${owner}: ${anchor} must not collapse near ${phrase}`);
}
function forbid(source, owner, patterns) {
  for (const pattern of patterns) if (pattern.test(source)) failures.push(`${owner}: forbidden ${pattern}`);
}
function requireOrder(source, owner, phrases) {
  let cursor = 0;
  for (const phrase of phrases) {
    const index = source.indexOf(phrase, cursor);
    if (index < 0) {
      failures.push(`${owner}: missing or reordered ${phrase}`);
      return;
    }
    cursor = index + phrase.length;
  }
}
function functionSlice(source, owner, start, end) {
  const startIndex = source.indexOf(start);
  if (startIndex < 0) {
    failures.push(`${owner}: missing ${start}`);
    return '';
  }
  const endIndex = source.indexOf(end, startIndex + start.length);
  if (endIndex < 0) return source.slice(startIndex);
  return source.slice(startIndex, endIndex);
}
function featureBlock(source, marker) {
  const start = source.indexOf(marker);
  if (start < 0) {
    failures.push(`feature block missing ${marker}`);
    return '';
  }
  // function map 的顶层 feature 项是 0 缩进（`- feature_id:`）；下一个
  // feature 用 0 或 2 空格缩进都算作块边界。
  let next = -1;
  for (const candidate of ['\n- feature_id:', '\n  - feature_id:']) {
    const found = source.indexOf(candidate, start + marker.length);
    if (found >= 0 && (next < 0 || found < next)) {
      next = found;
    }
  }
  return next < 0 ? source.slice(start) : source.slice(start, next);
}
function sectionSlice(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  if (start < 0) return '';
  const end = source.indexOf(endMarker, start + startMarker.length);
  return end < 0 ? source.slice(start) : source.slice(start, end);
}
