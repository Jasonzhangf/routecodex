#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { attachParityHelpers } from './v3-protocol-conversion-field-parity-lib.mjs';

// Validate declared data and owner edges. Runtime behavior belongs to the
// registered public consumers, not Rust spelling, source hashes or HTML bytes.
const repoRoot = process.env.ROUTECODEX_V3_SOURCE_ROOT
  ? resolve(process.env.ROUTECODEX_V3_SOURCE_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const paths = {
  fieldMatrix: 'docs/architecture/reviews/v3-protocol-semantic-field-matrix.yml',
  operationFieldProfiles: 'docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml',
  requestFieldProjectionManifest: 'docs/architecture/manifests/v3.protocol_request_field_projection.yml',
  requestFieldProjectionModules: 'docs/architecture/manifests/v3.protocol_request_field_projection.modules.yml',
  functionMap: 'docs/architecture/v3-function-map.yml',
  mainlineMap: 'docs/architecture/v3-mainline-call-map.yml',
  verificationMap: 'docs/architecture/v3-verification-map.yml',
  // Declaration labels used by parsed owner/artifact relationships, not reads.
  matrixReview: 'docs/architecture/reviews/v3-protocol-semantic-matrix-review.md',
  fieldMatrixHtml: 'docs/architecture/wiki/html/v3-protocol-semantic-field-matrix.html',
  gapCloseoutPlan: 'docs/goals/v3-protocol-semantic-field-gap-closeout-plan.md',
  responsesOpenaiCodec: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_openai_codec.rs',
  requestOutboundFormat: 'v3/crates/routecodex-v3-runtime/src/hub_v1/request_outbound_format.rs',
  requestOutboundResponsesItems: 'v3/crates/routecodex-v3-runtime/src/hub_v1/request_outbound_responses_items.rs',
  anthropicCodec: 'v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_codec.rs',
};
const readYaml = (file) => YAML.parse(readFileSync(resolve(repoRoot, file), 'utf8'));
const fieldMatrix = readYaml(paths.fieldMatrix);
const operationFieldProfiles = readYaml(paths.operationFieldProfiles);
const functionMap = readYaml(paths.functionMap);
const mainlineMap = readYaml(paths.mainlineMap);
const verificationMap = readYaml(paths.verificationMap);
const projectionManifest = readYaml(paths.requestFieldProjectionManifest);
const projectionModules = readYaml(paths.requestFieldProjectionModules);
const failures = [];
const helpers = attachParityHelpers({ failures, paths, operationFieldProfiles }, { current: fieldMatrix });

for (const semantic of [
  'request.metadata', 'request.client_metadata', 'request.prompt_cache_key', 'request.store',
  'request.text.output_config', 'request.reasoning_effort', 'request.reasoning_budget_tokens',
  'request.reasoning_summary_policy', 'request.reasoning_context_policy', 'request.reasoning_mode',
  'request.reasoning_include_thoughts', 'request.reasoning_display_policy', 'request.reasoning_thinking_mode',
]) {
  if (!(projectionManifest?.payload_semantics ?? []).includes(semantic)) {
    failures.push(`${paths.requestFieldProjectionManifest}: missing payload semantic ${semantic}`);
  }
}
const projectionSemantics = new Map((projectionManifest?.semantic_registry ?? []).map((entry) => [entry?.semantic_id, entry]));
for (const [id, storage, projections] of [
  ['request.metadata', 'routecodex_chat_extension.responses_request.metadata', { responses: 'metadata_openai_limits', openai_chat: 'metadata_openai_limits', anthropic: 'user_id_to_provider_wire_other_keys_to_response_projection_context', gemini: 'unmapped' }],
  ['request.client_metadata', 'routecodex_chat_extension.responses_request.client_metadata', { responses: 'client_metadata', openai_chat: 'user_id_projection_other_fields_unmapped', anthropic: 'user_id_projection_other_fields_unmapped', gemini: 'unmapped' }],
  ['request.prompt_cache_key', 'routecodex_chat_extension.responses_request.prompt_cache_key', { responses: 'prompt_cache_key', openai_chat: 'prompt_cache_key', anthropic: 'unmapped', gemini: 'unmapped' }],
  ['request.store', 'routecodex_chat_extension.responses_request.store', { responses: 'store', openai_chat: 'store', anthropic: 'false_consumed_true_unsupported', gemini: 'unmapped' }],
  ['request.reasoning_effort', 'reasoning_effort', { responses: 'reasoning.effort_known_domain_unknown_to_medium', openai_chat: 'reasoning_effort_provider_compatible_domain', anthropic: 'output_config.effort_or_minimax_adaptive_thinking', gemini: 'generationConfig.thinkingConfig.thinkingLevel_shared_domain_only' }],
  ['request.reasoning_budget_tokens', 'reasoning_budget_tokens', { responses: 'unmapped', openai_chat: 'unmapped', anthropic: 'thinking.budget_tokens_with_thinking_constraints', gemini: 'generationConfig.thinkingConfig.thinkingBudget_with_model_constraints' }],
  ['request.reasoning_summary_policy', 'reasoning_summary_policy', { responses: 'reasoning.summary', openai_chat: 'compatible_reasoning_effort_auto_medium_concise_low_detailed_high_merge_higher', anthropic: 'static_compatible_full_native_thinking_summary', gemini: 'unmapped' }],
  ['request.reasoning_context_policy', 'reasoning_context_policy', { responses: 'reasoning.context', openai_chat: 'consumed_source_roundtrip_only_no_wire', anthropic: 'unmapped', gemini: 'unmapped' }],
  ['request.reasoning_mode', 'reasoning_mode', { responses: 'reasoning.mode', openai_chat: 'unmapped', anthropic: 'unmapped', gemini: 'unmapped' }],
  ['request.reasoning_include_thoughts', 'reasoning_include_thoughts', { responses: 'unmapped', openai_chat: 'unmapped', anthropic: 'unmapped', gemini: 'generationConfig.thinkingConfig.includeThoughts' }],
  ['request.reasoning_display_policy', 'reasoning_display_policy', { responses: 'unmapped', openai_chat: 'unmapped', anthropic: 'thinking.display', gemini: 'unmapped' }],
  ['request.reasoning_thinking_mode', 'reasoning_thinking_mode', { responses: 'unmapped', openai_chat: 'unmapped', anthropic: 'thinking.type', gemini: 'unmapped' }],
]) {
  const entry = projectionSemantics.get(id);
  if (!entry) { failures.push(`${paths.requestFieldProjectionManifest}: missing semantic_registry entry ${id}`); continue; }
  if (entry.chat_storage !== storage) failures.push(`${paths.requestFieldProjectionManifest}: ${id} chat_storage must be ${storage}`);
  for (const [protocol, projection] of Object.entries(projections)) {
    if (entry.projections?.[protocol] !== projection) failures.push(`${paths.requestFieldProjectionManifest}: ${id} ${protocol} projection must be ${projection}`);
  }
}
const ownedPaths = (projectionModules?.modules ?? []).flatMap((module) => module.owned_paths ?? []);
for (const file of [
  'responses_openai_codec.rs', 'request_outbound_format.rs', 'anthropic_codec.rs',
  'anthropic_codec/projection_context.rs', 'anthropic_request_field_projection.rs', 'gemini_codec.rs',
  'provider_req_compat_06_provider_compat.rs',
]) {
  const path = `v3/crates/routecodex-v3-runtime/src/hub_v1/${file}`;
  if (ownedPaths.filter((owned) => owned === path).length !== 1) failures.push(`${paths.requestFieldProjectionModules}: ${path} must have exactly one feature-scoped module owner`);
}
for (const [from, to, direction] of [
  ['V3HubReqChatProcess04Governed', 'v3.protocol_codec.provider_compat_dispatch', 'outbound'],
  ['v3.protocol_codec.provider_compat_dispatch', 'v3.protocol_codec.openai_outbound', 'outbound_openai'],
  ['v3.protocol_codec.provider_compat_dispatch', 'v3.protocol_codec.anthropic', 'outbound_anthropic'],
  ['v3.protocol_codec.provider_compat_dispatch', 'v3.protocol_codec.gemini', 'outbound_gemini_dispatch'],
]) {
  if (!(projectionModules?.allowed_edges ?? []).some((edge) => edge?.from === from && edge?.to === to && edge?.direction === direction)) {
    failures.push(`${paths.requestFieldProjectionModules}: missing adjacent ${direction} edge ${from} -> ${to}`);
  }
}

const contract = fieldMatrix?.outbound_projection_contract;
if (contract?.control_provenance !== 'typed_owner_not_business_key_spelling') {
  failures.push(`${paths.fieldMatrix}: only typed owner provenance can identify control; business names must remain opaque`);
}
for (const status of ['mapped', 'transformed', 'consumed_by_transform', 'target_unsupported', 'control_forbidden']) {
  if (!contract?.legacy_outbound_consumption_statuses?.[status]) failures.push(`${paths.fieldMatrix}: missing legacy outbound projection status bridge ${status}`);
}
for (const value of ['mapped_exact', 'mapped_compatible_registered', 'unsupported']) {
  if (!JSON.stringify(contract?.projection_class_bridge ?? {}).includes(value)) failures.push(`${paths.fieldMatrix}: projection class bridge missing ${value}`);
}
for (const value of [
  'no_local_business_shape_rejection', 'opaque_original_value_forwarded_with_inverse_association',
  'ControlFieldLeak', 'recursive automatic strip', 'unknown source field ignore',
  'request.include', 'request.client_metadata', 'request.container', 'request.safetySettings', 'metadata_center', '_debug',
]) {
  if (!JSON.stringify(contract ?? {}).includes(value)) failures.push(`${paths.fieldMatrix}: outbound projection contract missing ${value}`);
}
const fieldMapPath = 'v3/crates/routecodex-v3-runtime/tables/request_field_map.json';
const fieldMap = JSON.parse(readFileSync(resolve(repoRoot, fieldMapPath), 'utf8'));
for (const field of ['audio', 'modalities', 'prediction', 'prompt_cache_key', 'prompt_cache_options', 'prompt_cache_retention', 'service_tier', 'store', 'web_search_options']) {
  if (!(fieldMap.whitelists?.openai_chat ?? []).includes(field)) failures.push(`${fieldMapPath}: whitelists.openai_chat missing ${field}`);
}
if ((fieldMap.whitelists?.responses ?? []).includes('previous_response_id')) failures.push(`${fieldMapPath}: relay continuation owner must consume previous_response_id before outbound`);
if (!(fieldMap.whitelists?.responses ?? []).includes('thinking')) failures.push(`${fieldMapPath}: whitelists.responses missing thinking`);
const finishMapPath = 'v3/crates/routecodex-v3-runtime/tables/finish_reason_map.json';
const finishMap = JSON.parse(readFileSync(resolve(repoRoot, finishMapPath), 'utf8'));
for (const row of finishMap.values ?? []) {
  if (row.openai_chat === 'stop' && row.hub !== 'stop') {
    failures.push(`${finishMapPath}: non-stop terminal ${row.hub} must not map to stop`);
  }
}
if (!(finishMap.values ?? []).some((row) => row.hub === 'content_filter' && row.anthropic === 'refusal' && row.openai_chat === 'content_filter' && row.responses === 'content_filter')) {
  failures.push(`${finishMapPath}: missing registered refusal/content_filter identity`);
}

const parityId = 'v3.protocol_conversion_field_parity';
const feature = (functionMap?.features ?? []).find((entry) => entry?.feature_id === parityId);
for (const symbol of ['execute_v3_responses_relay_runtime_inner', 'project_v3_responses_tool_call_to_openai_chat', 'responses_openai_chat_field_parity_direct_kernel_preserves_responses_input_include_and_tool_history']) {
  if (!(feature?.entry_symbols ?? []).includes(symbol)) failures.push(`${paths.functionMap}: protocol parity missing entry ${symbol}`);
}
if ([...(feature?.owner_files ?? []), ...(feature?.allowed_paths ?? [])].some((path) => /MetadataCenter|metadata_center/.test(path))) failures.push(`${paths.functionMap}: protocol parity business owner must not be MetadataCenter`);
if ((feature?.mainline_bindings ?? []).some((entry) => String(entry).includes('responses-chat-req-negative'))) failures.push(`${paths.functionMap}: projectable malformed arguments must not retain negative mainline bindings`);
const chain = (mainlineMap?.chains ?? []).find((entry) => entry?.chain_id === parityId);
const malformed = (chain?.edges ?? []).find((edge) => edge?.step_id === 'v3-protocol-field-parity-responses-chat-malformed-arguments-project-01');
const codec = 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_openai_codec.rs';
for (const [key, expected] of Object.entries({
  from_node: 'ProviderReqCompat06ProviderCompat', to_node: 'V3ProviderReqOutbound08WirePayload',
  caller_symbol: 'build_v3_openai_chat_assistant_tool_call_message', caller_file: codec,
  callee_symbol: 'project_v3_responses_tool_call_to_openai_chat', callee_file: codec,
})) {
  if (malformed?.[key] !== expected) failures.push(`${paths.mainlineMap}: malformed-arguments runtime edge ${key} must be ${expected}`);
}
if ((malformed?.resource_flow?.side_channel_writes ?? []).length) failures.push(`${paths.mainlineMap}: malformed-arguments field projector must not claim error/control writes`);
for (const edge of chain?.edges ?? []) {
  if (String(edge.step_id).includes('responses-chat-req-negative') || ['v3-protocol-field-parity-responses-direct-kernel-01', 'v3-protocol-field-parity-responses-direct-wire-01'].includes(edge.step_id)) {
    failures.push(`${paths.mainlineMap}: retired negative or duplicate Direct parity edge ${edge.step_id}`);
  }
}
const action = (mainlineMap?.chains ?? []).find((entry) => entry?.chain_id === 'v3.provider_action_gate.mainline');
const compatError = (action?.edges ?? []).find((edge) => edge?.step_id === 'v3-provider-action-gate-01');
for (const [key, expected] of Object.entries({
  from_node: 'ProviderReqCompat06ProviderCompat', to_node: 'V3Error05ExecutionDecision',
  caller_symbol: 'execute_v3_responses_relay_runtime_inner_with_refill',
  caller_file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime_inner.rs',
  callee_symbol: 'handle_v3_responses_relay_provider_failure',
  callee_file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs',
})) {
  if (compatError?.[key] !== expected) failures.push(`${paths.mainlineMap}: ProviderReqCompat06 typed failure edge ${key} must be ${expected}`);
}
const direct = (mainlineMap?.chains ?? []).find((entry) => entry?.chain_id === 'v3.responses_direct.required_mainline');
for (const [id, expected] of Object.entries({
  'v3-rd-09-direct-policy': { from_node: 'V3Execution11ProtocolDecision', to_node: 'V3ResponsesDirect11Policy', caller_symbol: 'execute_v3_responses_direct_runtime_kernel', caller_file: 'v3/crates/routecodex-v3-runtime/src/kernel.rs', callee_symbol: 'responses_direct_route_hook', callee_file: 'v3/crates/routecodex-v3-runtime/src/hooks.rs', owner_feature_id: 'v3.responses_direct_mvp_architecture' },
  'v3-rd-10': { from_node: 'V3ResponsesDirect11Policy', to_node: 'V3Provider12ResponsesWirePayload', caller_symbol: 'responses_direct_request_projection_hook', caller_file: 'v3/crates/routecodex-v3-runtime/src/hooks.rs', callee_symbol: 'build_v3_provider_12_responses_wire_payload', callee_file: 'v3/crates/routecodex-v3-provider-responses/src/wire.rs', owner_feature_id: 'v3.responses_provider_runtime' },
})) {
  const edge = (direct?.edges ?? []).find((entry) => entry?.step_id === id);
  for (const [key, value] of Object.entries(expected)) {
    if (edge?.[key] !== value) failures.push(`${paths.mainlineMap}: ${id} ${key} must be ${value}`);
  }
}
const verification = (verificationMap?.features ?? []).find((entry) => entry?.feature_id === parityId);
for (const test of [
  'issue0e129d0_anthropic_nonstop_reason_public',
  'issue0e129d0_actual_error_uses_error_chain_and_switches_provider',
  'responses_wire_representation_survives_chat_and_anthropic_entries',
  'genuine_http_and_native_sse_errors_break_transport_without_client_error',
  'responses_openai_chat_field_parity_paired_malformed_arguments_preserve_exact_string_without_reselect',
  'responses_openai_chat_field_parity_unpaired_malformed_arguments_preserve_exact_string_without_reselect',
  'responses_malformed_function_call_arguments_keep_pair_with_reversible_anthropic_input',
  'chat_malformed_tool_call_arguments_keep_pair_with_reversible_anthropic_input',
  'responses_openai_chat_field_parity_direct_kernel_preserves_responses_input_include_and_tool_history',
]) {
  if (!(verification?.required_blackbox ?? []).some((entry) => String(entry).includes(test))) failures.push(`${paths.verificationMap}: missing required_blackbox ${test}`);
}

for (const [protocol, section, fields] of [
  ['responses', 'request_fields', ['request.background', 'request.context_management', 'request.conversation', 'request.prompt_cache_key', 'request.prompt_cache_options.ttl', 'request.text.format', 'request.top_logprobs']],
  ['responses', 'input_fields', ['request.input[].content[].detail', 'request.input[].content[].file_data', 'request.input[].summary[].text', 'request.input[].call_id']],
  ['responses', 'response_fields', ['response.completed_at', 'response.prompt_cache_retention', 'response.safety_identifier', 'response.usage.total_tokens']],
  ['openai_chat', 'request_fields', ['request.audio.format', 'request.modalities', 'request.reasoning_effort', 'request.web_search_options', 'request.stream_options.include_usage']],
  ['openai_chat', 'message_fields', ['request.messages[].content[].input_audio.data', 'request.messages[].content[].file.file_id', 'request.messages[].tool_calls[].custom.input']],
  ['openai_chat', 'response_fields', ['response.choices[].message.audio', 'response.choices[].message.tool_calls', 'response.system_fingerprint', 'response.usage.total_tokens']],
  ['anthropic', 'request_fields', ['request.container', 'request.output_config.format.schema', 'request.thinking.budget_tokens', 'request.user_profile_id']],
  ['anthropic', 'content_block_fields', ['request.messages[].content[].caller', 'request.messages[].content[].is_error', 'request.messages[].content[].content']],
  ['anthropic', 'response_fields', ['response.container.id', 'response.stop_details', 'response.usage.cache_creation_input_tokens', 'response.usage.service_tier']],
  ['gemini', 'request_fields', ['request.systemInstruction.parts', 'request.serviceTier', 'request.store']],
  ['gemini', 'content_part_fields', ['request.contents[].parts[].thoughtSignature', 'request.contents[].parts[].toolCall.args', 'request.contents[].parts[].videoMetadata.fps']],
  ['gemini', 'tool_fields', ['request.toolConfig.functionCallingConfig.allowedFunctionNames', 'request.tools[].functionDeclarations[].parametersJsonSchema']],
  ['gemini', 'generation_config_fields', ['request.generationConfig.responseMimeType', 'request.generationConfig.responseModalities', 'request.generationConfig.thinkingConfig.thinkingBudget']],
  ['gemini', 'response_fields', ['response.modelVersion', 'response.responseId', 'response.usageMetadata.totalTokenCount', 'response.candidates[].groundingMetadata']],
]) helpers.requireInventoryFields(fieldMatrix, protocol, section, fields);
for (const [protocol, extension, fields] of [
  ['responses', 'prompt_cache', ['request.prompt_cache_key', 'request.prompt_cache_options.ttl']],
  ['openai_chat', 'audio_and_modalities', ['request.audio.format', 'request.modalities']],
  ['anthropic', 'container_and_output_config', ['request.output_config.format.schema', 'response.container.id']],
  ['gemini', 'tool_config', ['request.toolConfig.functionCallingConfig.allowedFunctionNames', 'request.tools[].functionDeclarations[].parametersJsonSchema']],
  ['gemini', 'generation_config', ['request.generationConfig.thinkingConfig.thinkingBudget', 'request.generationConfig.responseMimeType']],
]) helpers.requireExtensionFields(fieldMatrix, protocol, extension, fields);
helpers.requireClassificationCoversSourceInventory(fieldMatrix);
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
]) helpers.requireSemanticCorrespondence(fieldMatrix, semantic, protocol, fields);
helpers.requireMatrixProtocols(fieldMatrix, ['responses', 'openai_chat', 'anthropic', 'gemini']);
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
]) helpers.requireMatrixFields(fieldMatrix, protocol, section, fields);
for (const semantic of ['model.identity', 'turn.messages', 'message.content_parts', 'tool.declarations', 'tool.calls', 'tool.result', 'reasoning.request_fields', 'reasoning.visible_content', 'usage.tokens', 'response.finish_reason']) {
  if (!fieldMatrix?.canonical_chat_semantics?.[semantic]) failures.push(`${paths.fieldMatrix}: missing canonical_chat_semantics.${semantic}`);
}
for (const gap of ['gap.client_metadata.target_dependent', 'gap.gemini.field_coverage', 'gap.openai_chat.long_tail_fields', 'gap.responses.long_tail_fields']) {
  if (!fieldMatrix?.implementation_gaps?.some((entry) => entry?.id === gap)) failures.push(`${paths.fieldMatrix}: missing implementation gap ${gap}`);
}
helpers.requireNoPendingAuditStatus(fieldMatrix);
helpers.requireCanonicalExtensionRegistry(fieldMatrix);
helpers.requireAuditTruthContract(fieldMatrix);
helpers.requireManualSemanticTranslationGroups(fieldMatrix);
helpers.requireShapeBranchTransformContract(fieldMatrix);
helpers.requireBranchAwareSemanticGroups(fieldMatrix);
helpers.requireInverseResponseTextBranchContract(fieldMatrix);
helpers.requireGeminiToolConfigSemanticContract(fieldMatrix);
helpers.requireGeminiThinkingConfigSemanticContract(fieldMatrix);
helpers.requireGeminiGenerationConfigScalarSemanticContract(fieldMatrix);
helpers.requireExtendedOpenAiChatSemanticSuperset(fieldMatrix);
if (failures.length) {
  console.error('[verify:v3-protocol-conversion-field-parity] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('[verify:v3-protocol-conversion-field-parity] ok');
