#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import {
  renderV3ProtocolSemanticFieldMatrix,
  renderV3ProtocolSemanticFieldMatrixHtml,
  V3_PROTOCOL_SEMANTIC_FIELD_MATRIX_HTML_PATH,
  V3_PROTOCOL_SEMANTIC_FIELD_MATRIX_PATH,
} from './render-v3-protocol-semantic-field-matrix.mjs';

const paths = {
  design: 'docs/goals/v3-protocol-conversion-field-parity-test-design.md',
  gapCloseoutPlan: 'docs/goals/v3-protocol-semantic-field-gap-closeout-plan.md',
  hub: 'v3/crates/routecodex-v3-runtime/src/hub_v1.rs',
  responsesOpenaiCodec: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_openai_codec.rs',
  requestOutboundFormat: 'v3/crates/routecodex-v3-runtime/src/hub_v1/request_outbound_format.rs',
  providerReqCompat: 'v3/crates/routecodex-v3-runtime/src/hub_v1/provider_req_compat_06_provider_compat.rs',
  responsesRuntime: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs',
  anthropicCodec: 'v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_codec.rs',
  anthropicProjection: 'v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime_codec.rs',
  geminiCodec: 'v3/crates/routecodex-v3-runtime/src/hub_v1/gemini_codec.rs',
  responsesTests: 'v3/crates/routecodex-v3-runtime/tests/responses_relay_local_continuation_integration.rs',
  responsesAnthropicProviderTests: 'v3/crates/routecodex-v3-runtime/tests/responses_relay_anthropic_provider_wire_integration.rs',
  anthropicTests: 'v3/crates/routecodex-v3-runtime/tests/anthropic_relay_runtime_integration.rs',
  openaiTests: 'v3/crates/routecodex-v3-runtime/tests/openai_chat_relay_runtime_integration.rs',
  geminiTests: 'v3/crates/routecodex-v3-runtime/tests/hub_gemini_codec_characterization.rs',
  functionMap: 'docs/architecture/v3-function-map.yml',
  mainlineMap: 'docs/architecture/v3-mainline-call-map.yml',
  verificationMap: 'docs/architecture/v3-verification-map.yml',
  resourceMap: 'docs/architecture/v3-resource-operation-map.yml',
  packageJson: 'package.json',
  matrixReview: 'docs/architecture/reviews/v3-protocol-semantic-matrix-review.md',
  fieldMatrix: V3_PROTOCOL_SEMANTIC_FIELD_MATRIX_PATH,
  fieldMatrixHtml: V3_PROTOCOL_SEMANTIC_FIELD_MATRIX_HTML_PATH,
  fieldMatrixRenderer: 'scripts/architecture/render-v3-protocol-semantic-field-matrix.mjs',
};

const text = Object.fromEntries(Object.entries(paths).map(([key, path]) => [key, readFileSync(path, 'utf8')]));
const failures = [];
const fieldMatrix = YAML.parse(text.fieldMatrix);

for (const phrase of [
  'Responses entry -> OpenAI Chat provider wire -> Responses client projection',
  'Anthropic Messages entry -> Responses provider wire -> Anthropic Messages client projection',
  'OpenAI Chat entry -> OpenAI Chat provider wire -> OpenAI Chat client projection',
  'Responses entry -> Anthropic Messages provider wire -> Responses client projection',
  'OpenAI Chat provider wire preserves `metadata` but strips non-standard `client_metadata`',
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
  '"max_output_tokens"',
  '"metadata"',
  '"client_metadata"',
  '"stop"',
  'responses_reasoning_request_config_as_openai_chat_reasoning_effort',
  '"reasoning_effort"',
]) requireText(responsesToChat, `${paths.responsesOpenaiCodec}::build_v3_chat_canonical_request_from_responses_payload`, phrase);
requireOrder(responsesToChat, `${paths.responsesOpenaiCodec}::responses_to_chat_copy_list`, [
  '"max_output_tokens"',
  '"metadata"',
  '"client_metadata"',
  '"stop"',
]);
forbid(responsesToChat, `${paths.responsesOpenaiCodec}::build_v3_chat_canonical_request_from_responses_payload`, [/fallback/i, /MetadataCenter|metadata_center|runtime_control/i]);

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
  'fn is_provider_outbound_control_key',
  '"metadata_center"',
  '"runtime_control"',
]) requireText(text.requestOutboundFormat, paths.requestOutboundFormat, phrase);
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
  'json!({"effort":"medium","thinking":thinking})',
  'anthropic_tool_choice_as_responses_tool_choice',
]) requireText(anthropicToResponses, `${paths.anthropicCodec}::anthropic_to_responses`, phrase);
forbid(anthropicToResponses, `${paths.anthropicCodec}::anthropic_to_responses`, [/fallback/i, /MetadataCenter|metadata_center|debug_snapshot|runtime_control/i]);

const responsesRequestToAnthropic = functionSlice(
  text.anthropicCodec,
  paths.anthropicCodec,
  'pub fn encode_v3_responses_semantic_as_anthropic_request',
  'pub fn project_v3_anthropic_message_as_responses_response',
);
for (const phrase of [
  'pub fn encode_v3_responses_semantic_as_anthropic_request',
  'if let Some(thinking) = responses_reasoning_request_config_as_anthropic_thinking(object) {',
  'responses_reasoning_request_config_as_anthropic_thinking',
  'responses_reasoning_effort_as_anthropic_budget',
  '"budget_tokens"',
  'output.insert("thinking".to_string(), thinking)',
]) requireText(responsesRequestToAnthropic, `${paths.anthropicCodec}::responses_request_to_anthropic`, phrase);
forbid(responsesRequestToAnthropic, `${paths.anthropicCodec}::responses_request_to_anthropic`, [/MetadataCenter|metadata_center|debug_snapshot|runtime_control/i]);

const providerReqCompat = functionSlice(
  text.providerReqCompat,
  paths.providerReqCompat,
  'fn build_v3_provider_standard_protocol_payload_from_req07',
  'fn __v3_provider_req_compat_slice_end__',
);
for (const phrase of [
  'V3HubProviderWireProtocol::Anthropic',
  'V3HubProviderWireProtocol::Anthropic => {\n            if let Some(original_surface) =\n                build_v3_responses_original_input_surface_from_chat_canonical(\n                    input.provider_semantic_payload(),\n                    input.original_responses_payload(),\n                )',
  'build_v3_responses_original_input_surface_from_chat_canonical',
  'input.original_responses_payload()',
]) requireText(providerReqCompat, `${paths.providerReqCompat}::anthropic_original_responses_surface`, phrase);
forbid(providerReqCompat, `${paths.providerReqCompat}::anthropic_original_responses_surface`, [/fallback/i, /MetadataCenter|metadata_center|runtime_control/i]);

const responsesOriginalInputSurface = functionSlice(
  text.requestOutboundFormat,
  paths.requestOutboundFormat,
  'pub(crate) fn build_v3_responses_original_input_surface_from_chat_canonical',
  'fn has_responses_non_message_input_surface',
);
for (const phrase of [
  'pub(crate) fn build_v3_responses_original_input_surface_from_chat_canonical',
  'original.get("input")?;',
  'merge_chat_governance_into_original_responses_surface',
  'normalize_responses_payload_for_provider_standard',
]) requireText(responsesOriginalInputSurface, `${paths.requestOutboundFormat}::responses_original_input_surface`, phrase);
forbid(responsesOriginalInputSurface, `${paths.requestOutboundFormat}::responses_original_input_surface`, [
  /original\.get\("input"\)\.and_then\(Value::as_array\)\?/,
  /MetadataCenter|metadata_center|runtime_control/i,
]);

const responsesToAnthropic = functionSlice(
  text.anthropicProjection,
  paths.anthropicProjection,
  'pub fn project_v3_responses_json_as_anthropic_message',
  'pub fn project_v3_responses_sse_as_anthropic_events',
);
for (const phrase of [
  'pub fn project_v3_responses_json_as_anthropic_message',
  'parse_responses_function_call_arguments',
  'responses_custom_tool_call_input',
  '"thinking"',
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
    'OpenAI Chat provider wire must project Responses reasoning to reasoning_effort',
    'OpenAI Chat provider wire must not forward non-standard client_metadata',
  ]],
  [paths.responsesAnthropicProviderTests, text.responsesAnthropicProviderTests, [
    'responses_relay_reasoning_request_config_reaches_anthropic_provider_as_thinking',
    'responses_relay_string_input_reasoning_request_config_reaches_anthropic_provider_as_thinking',
    'responses_relay_anthropic_provider_json_preserves_thinking_to_responses_reasoning',
    'json!({"type":"enabled","budget_tokens":4096})',
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

for (const [owner, body, phrases] of [
  [paths.functionMap, text.functionMap, [
    'feature_id: v3.protocol_conversion_field_parity',
    'v3-protocol-field-parity-responses-chat-req-01',
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
    'build_v3_openai_chat_standard_request_from_chat_canonical',
    'build_provider_req_compat_06_from_v3_hub_req_outbound_07',
  ]],
  [paths.mainlineMap, text.mainlineMap, [
    'chain_id: v3.protocol_conversion_field_parity',
    'binding_kind: protocol_field_parity_test_over_existing_relay_chain',
    'v3-protocol-field-parity-responses-chat-req-01',
    'v3-protocol-field-parity-responses-anthropic-req-01',
    'v3-protocol-field-parity-openai-chat-same-protocol-01',
  ]],
  [paths.verificationMap, text.verificationMap, [
    'feature_id: v3.protocol_conversion_field_parity',
    'Responses request to OpenAI Chat provider wire preserves OpenAI Chat data-plane metadata/stop',
    'Anthropic thinking is preserved under Responses reasoning.thinking',
    'Responses reasoning.effort/summary request config reaches Anthropic provider wire as thinking',
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

const parityFeatureBlock = featureBlock(text.functionMap, 'feature_id: v3.protocol_conversion_field_parity');
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
  'OpenAI Chat wire strips `client_metadata` before provider send.',
  'Gemini still needs clearer semantic ownership',
  'Source field inventory',
  'Canonical textual truth for the field-matrix audit',
  'Audited status legend and counts',
  '`extension_declared` | 214',
  '`semantic_declared` | 59',
  '`source_inventory_only` | 0',
  '`shape_branch_gap` | 18',
  '`codec_shape_only` | 14',
  '`partial` | 84',
  'Gap audit for runtime closeout',
  'gap.runtime_extension_declared',
  'gap.semantic_declared_runtime_closeout',
  'gap.partial_cross_protocol_semantics',
  'docs/goals/v3-protocol-semantic-field-gap-closeout-plan.md',
]) requireText(text.matrixReview, paths.matrixReview, phrase);
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
  ['reasoning.request_config', 'anthropic', ['request.thinking.type']],
  ['reasoning.request_config', 'gemini', ['request.generationConfig.thinkingConfig.thinkingLevel']],
  ['reasoning.request_include_thoughts', 'anthropic', ['request.thinking.display']],
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
for (const semantic of ['model.identity', 'turn.messages', 'message.content_parts', 'tool.declarations', 'tool.calls', 'tool.result', 'reasoning.request_config', 'reasoning.visible_content', 'usage.tokens', 'response.finish_reason']) {
  if (!fieldMatrix?.canonical_chat_semantics?.[semantic]) failures.push(`${paths.fieldMatrix}: missing canonical_chat_semantics.${semantic}`);
}
for (const gapId of ['gap.client_metadata.target_dependent', 'gap.gemini.field_coverage', 'gap.openai_chat.long_tail_fields', 'gap.responses.long_tail_fields']) {
  if (!fieldMatrix?.implementation_gaps?.some((gap) => gap?.id === gapId)) failures.push(`${paths.fieldMatrix}: missing implementation gap ${gapId}`);
}

requireNoPendingAuditStatus(fieldMatrix);
requireAuditTruthContract(fieldMatrix);
requireManualSemanticTranslationGroups(fieldMatrix);
requireShapeBranchTransformContract(fieldMatrix);
requireGeminiToolConfigSemanticContract(fieldMatrix);
requireGeminiThinkingConfigSemanticContract(fieldMatrix);
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
if (pkg.scripts?.['render:v3-protocol-semantic-field-matrix'] !== 'node scripts/architecture/render-v3-protocol-semantic-field-matrix.mjs') {
  failures.push(`${paths.packageJson}: render:v3-protocol-semantic-field-matrix must run node scripts/architecture/render-v3-protocol-semantic-field-matrix.mjs`);
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
    ['gap.client_metadata.target_dependent', 'covered_but_target_dependent', 'gated_no_runtime_gap'],
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
    if (!(include.chat_fields ?? []).includes('request.reasoning.include_thoughts')) failures.push(`${paths.fieldMatrix}: reasoning.request_include_thoughts missing request.reasoning.include_thoughts chat field`);
    const gemini = include.protocol_mappings?.gemini?.request_fields ?? [];
    if (!gemini.includes('request.generationConfig.thinkingConfig.includeThoughts')) failures.push(`${paths.fieldMatrix}: reasoning.request_include_thoughts must map Gemini includeThoughts`);
  }
  const budget = byId.get('reasoning.request_budget_tokens');
  if (!budget) failures.push(`${paths.fieldMatrix}: missing reasoning.request_budget_tokens semantic group`);
  else {
    if (!(budget.chat_fields ?? []).includes('request.reasoning.budget_tokens')) failures.push(`${paths.fieldMatrix}: reasoning.request_budget_tokens missing request.reasoning.budget_tokens chat field`);
    const gemini = budget.protocol_mappings?.gemini?.request_fields ?? [];
    if (!gemini.includes('request.generationConfig.thinkingConfig.thinkingBudget')) failures.push(`${paths.fieldMatrix}: reasoning.request_budget_tokens must map Gemini thinkingBudget`);
    if ((budget.protocol_mappings?.gemini?.request_fields ?? []).includes('request.generationConfig.maxOutputTokens')) failures.push(`${paths.fieldMatrix}: Gemini thinkingBudget must not collapse into maxOutputTokens`);
  }
  for (const [field, expected, forbidden] of [
    ['request.reasoning_effort', ['request.generationConfig.thinkingConfig.thinkingLevel'], ['request.generationConfig.thinkingConfig.includeThoughts', 'request.generationConfig.thinkingConfig.thinkingBudget']],
    ['request.reasoning.include_thoughts', ['request.generationConfig.thinkingConfig.includeThoughts'], ['request.generationConfig.thinkingConfig.thinkingBudget', 'request.generationConfig.thinkingConfig.thinkingLevel']],
    ['request.reasoning.budget_tokens', ['request.generationConfig.thinkingConfig.thinkingBudget'], ['request.generationConfig.maxOutputTokens', 'response.usageMetadata.thoughtsTokenCount', 'request.generationConfig.thinkingConfig.includeThoughts']],
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
  const next = source.indexOf('\n  - feature_id:', start + marker.length);
  return next < 0 ? source.slice(start) : source.slice(start, next);
}
function sectionSlice(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  if (start < 0) return '';
  const end = source.indexOf(endMarker, start + startMarker.length);
  return end < 0 ? source.slice(start) : source.slice(start, end);
}
