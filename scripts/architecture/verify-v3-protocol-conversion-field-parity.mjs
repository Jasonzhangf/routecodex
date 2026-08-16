#!/usr/bin/env node
import { readFileSync } from 'node:fs';import YAML from 'yaml';
import { attachParityHelpers } from './v3-protocol-conversion-field-parity-lib.mjs';
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
  providerCompatCore: 'sharedmodule/llmswitch-core/rust-core/crates/provider-compat-core/src/lib.rs',
  directPassthroughTests: 'v3/crates/routecodex-v3-runtime/tests/responses_direct_tool_passthrough.rs',
  responsesRuntime: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs',
  responsesRuntimeInner: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime_inner.rs',
  responsesRuntimeTests: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime_tests.rs',
  responsesRuntimeTestsExtra: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime_tests_extra.rs',
  responsesRelayDryRun: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_dry_run.rs',
  responsesRelayTypes: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_types.rs',
  webSearchHop: 'v3/crates/routecodex-v3-runtime/src/hub_v1/web_search_hop.rs',
  responsesOpenaiChatConversion: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_openai_chat_conversion.rs',
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
const {
  addUnique,
  classificationBucketForField,
  collectSourceInventoryFields,
  currentImplCounts,
  extensionIdsForField,
  forbid,
  forbidGroupFields,
  forbidNear,
  forbidSupersetRowFields,
  functionSlice,
  groupProtocolFields,
  requireAuditTruthContract,
  requireCanonicalExtensionRegistry,
  requireClassificationCoversSourceInventory,
  requireExtendedOpenAiChatSemanticSuperset,
  requireExtensionFields,
  requireGeminiGenerationConfigScalarSemanticContract,
  requireGeminiThinkingConfigSemanticContract,
  requireGeminiToolConfigSemanticContract,
  requireGroupFields,
  requireInventoryFields,
  requireManualSemanticTranslationGroups,
  requireMatrixFields,
  requireMatrixProtocols,
  requireNear,
  requireNoPendingAuditStatus,
  requireOrder,
  requireSemanticCorrespondence,
  requireShapeBranchTransformContract,
  requireShapeCaseFields,
  requireShapeCaseProtocols,
  requireSupersetRowFields,
  requireText,
  sectionSlice,
  supersetRowByField,
  featureBlock,
  walkCurrentImpl,
} = attachParityHelpers({ failures, paths, text });
const fieldMatrix = YAML.parse(text.fieldMatrix);
const functionMap = YAML.parse(text.functionMap);
const mainlineMap = YAML.parse(text.mainlineMap);
const verificationMap = YAML.parse(text.verificationMap);
const requestFieldProjectionManifest = YAML.parse(text.requestFieldProjectionManifest);
const requestFieldProjectionModules = YAML.parse(text.requestFieldProjectionModules);

const targetReasoningEffortProjection = functionSlice(
  text.providerReqCompat,
  paths.providerReqCompat,
  'fn project_reasoning_effort_for_selected_target',
  'fn build_v3_provider_standard_protocol_payload_from_req07',
);
forbid(text.providerCompatCore, `${paths.providerCompatCore}::target_effort_unique_owner`, [
  /fn apply_deepseek_max_request_compat/u,
]);
requireText(text.responsesRelayTypes, `${paths.responsesRelayTypes}::client_input_error_type`, 'ClientInboundCanonical(String)');
requireText(text.responsesRelayDryRun, `${paths.responsesRelayDryRun}::client_input_error_projection`, 'V3ResponsesRelayRuntimeError::ClientInboundCanonical(message)');
requireText(text.responsesRuntimeInner, `${paths.responsesRuntimeInner}::provider_response_projection_error`, 'V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(');
requireText(text.webSearchHop, `${paths.webSearchHop}::internal_hop_error`, 'V3ResponsesRelayRuntimeError::WebSearchDispatchFailed(format!(');
requireText(text.responsesRuntimeTestsExtra, `${paths.responsesRuntimeTestsExtra}::error_origin_reverse_tests`, 'provider_response_projection_failure_is_not_client_invalid_request');
requireText(text.responsesRuntimeTestsExtra, `${paths.responsesRuntimeTestsExtra}::error_origin_reverse_tests`, 'internal_web_search_canonicalization_failure_is_not_client_invalid_request');
forbid(text.responsesRuntimeInner, `${paths.responsesRuntimeInner}::no_shared_client_error_variant`, [/V3ResponsesRelayRuntimeError::InboundCanonical\(/u]);
forbid(text.webSearchHop, `${paths.webSearchHop}::no_shared_client_error_variant`, [/V3ResponsesRelayRuntimeError::InboundCanonical\(/u]);
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
  ['request.reasoning_effort', 'reasoning_effort', { responses: 'reasoning.effort_known_domain_unknown_to_medium', openai_chat: 'reasoning_effort_provider_compatible_domain', anthropic: 'output_config.effort_or_minimax_adaptive_thinking', gemini: 'generationConfig.thinkingConfig.thinkingLevel_shared_domain_only' }],
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
  'project_outbound_payload_for_target_protocol',
  'ControlFieldLeak target_protocol={}',
  'UnmappedOutboundFields target_protocol={}',
  'fn is_provider_outbound_control_key',
  '"metadata_center"',
  '"runtime_control"',
]) requireText(text.requestOutboundFormat, paths.requestOutboundFormat, phrase);
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
  'openai_chat_function_tool_redacted_schema_placeholders_pass_through',
  'openai_responses_function_tool_redacted_schema_placeholders_pass_through',
  'openai_chat_tool_search_rejects_unmapped_builtin_tool',
  'openai_responses_provider_wire_maps_chat_token_and_logprob_pairs',
  'openai_responses_provider_wire_drops_top_logprobs_when_logprobs_disabled',
  'Responses provider wire must not emit non-spec max_tokens',
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

  // chat→responses 转换拆分到 responses_openai_chat_conversion.rs(worker 拆分后唯一真源)。
  const chatToResponses = text.responsesOpenaiChatConversion;
for (const phrase of [
  'fn build_v3_responses_provider_response_from_openai_chat_payload',
  'if let Some(model) = payload.get("model") {\n        response.insert("model".to_string(), model.clone());\n    }',
  'payload.get("created_at").or_else(|| payload.get("created"))',
  'normalize_v3_hub_responses_usage_from_openai_chat_usage',
  'build_v3_responses_reasoning_item_from_openai_chat_message',
  'build_v3_responses_function_call_from_openai_chat_tool_call',
]) requireText(chatToResponses, `${paths.responsesOpenaiChatConversion}::chat_to_responses_projection`, phrase);
forbid(chatToResponses, `${paths.responsesOpenaiChatConversion}::chat_to_responses_projection`, [/fallback/i, /MetadataCenter|metadata_center|runtime_control/i]);

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
for (const phrase of [
  'project_reasoning_effort_for_selected_target',
  '"responses:deepseek-console-go"',
  'serde_json::json!({"type":"adaptive"})',
  '"xhigh" | "max" => "max"',
  '"none" | "minimal" => "low"',
  '_ => "medium"',
]) requireText(targetReasoningEffortProjection, `${paths.providerReqCompat}::target_protocol_reasoning_effort_projection`, phrase);
forbid(targetReasoningEffortProjection, `${paths.providerReqCompat}::target_protocol_reasoning_effort_projection`, [/thinking_budget|budget_tokens|MetadataCenter|metadata_center/i]);
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
]) requireText(chatToResponses, `${paths.responsesOpenaiChatConversion}::chat_to_responses_projection`, phrase);
forbid(text.responsesRuntime, `${paths.responsesRuntime}::no_function_relabel_for_openai_chat_custom`, [/extract_v3_responses_custom_tool_input_from_openai_chat_arguments/]);
requireText(text.responsesRuntimeTests, `${paths.responsesRuntimeTests}::target_protocol_unmapped_field_skips_invalid_wire_and_switches_provider`, 'target_protocol_unmapped_field_skips_invalid_wire_and_switches_provider');
requireText(text.responsesRuntimeTests, `${paths.responsesRuntimeTests}::target_protocol_unmapped_field_skips_invalid_wire_and_switches_provider`, 'the incompatible Anthropic candidate must receive no wire request');
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
    'responses_relay_reasoning_effort_projects_minimax_adaptive_thinking',
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
const responsesAllowedFields = (requestFieldMap?.whitelists?.responses ?? []).join('\n');
forbid(
  responsesAllowedFields,
  `${paths.requestOutboundFormat}::relay_continuation_owner_consumed_before_outbound`,
  [/previous_response_id/],
);
for (const field of ['thinking']) {
  requireText(
    responsesAllowedFields,
    `${requestFieldMapRel}::whitelists.responses`,
    field,
  );
}
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
    'Responses reasoning.effort is preserved until concrete target selection',
    'DeepSeek active lower/unknown -> high and xhigh/max -> max',
    'MiniMax active effort',
    'thinking.type=adaptive without output_config.effort',
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
  ['caller_file', paths.responsesRuntimeInner],
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
if (!String(text.v3ArchitectureCi ?? '').includes("'verify:v3-protocol-conversion-field-parity-ci'")) {
  failures.push(`${paths.v3ArchitectureCi}: verify:v3-architecture-ci must run verify:v3-protocol-conversion-field-parity-ci`);
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
