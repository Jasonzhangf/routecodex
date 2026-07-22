#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const paths = {
  design: 'docs/goals/v3-protocol-conversion-field-parity-test-design.md',
  hub: 'v3/crates/routecodex-v3-runtime/src/hub_v1.rs',
  responsesOpenaiCodec: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_openai_codec.rs',
  requestOutboundFormat: 'v3/crates/routecodex-v3-runtime/src/hub_v1/request_outbound_format.rs',
  responsesRuntime: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs',
  anthropicCodec: 'v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_codec.rs',
  anthropicProjection: 'v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime_codec.rs',
  responsesTests: 'v3/crates/routecodex-v3-runtime/tests/responses_relay_local_continuation_integration.rs',
  anthropicTests: 'v3/crates/routecodex-v3-runtime/tests/anthropic_relay_runtime_integration.rs',
  openaiTests: 'v3/crates/routecodex-v3-runtime/tests/openai_chat_relay_runtime_integration.rs',
  functionMap: 'docs/architecture/v3-function-map.yml',
  mainlineMap: 'docs/architecture/v3-mainline-call-map.yml',
  verificationMap: 'docs/architecture/v3-verification-map.yml',
  resourceMap: 'docs/architecture/v3-resource-operation-map.yml',
  packageJson: 'package.json',
};

const text = Object.fromEntries(Object.entries(paths).map(([key, path]) => [key, readFileSync(path, 'utf8')]));
const failures = [];

for (const phrase of [
  'Responses entry -> OpenAI Chat provider wire -> Responses client projection',
  'Anthropic Messages entry -> Responses provider wire -> Anthropic Messages client projection',
  'OpenAI Chat entry -> OpenAI Chat provider wire -> OpenAI Chat client projection',
  '`metadata` and `client_metadata` in client protocol bodies are data-plane fields',
  'Forbidden owners: server handler, SSE transport, provider transport, continuation store, MetadataCenter, TS runtime, V2 sharedmodule code.',
  'RouteCodex-created control fields',
]) requireText(text.design, paths.design, phrase);

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
  'payload.get("model")',
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
    '"client_metadata":{"codex":"client-metadata-kept"}',
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
    'v3-protocol-field-parity-anthropic-responses-req-01',
    'v3-protocol-field-parity-responses-anthropic-resp-01',
    'v3-protocol-field-parity-openai-chat-same-protocol-01',
    'npm run verify:v3-protocol-conversion-field-parity',
    'npm run test:v3-protocol-conversion-field-parity-red-fixtures',
    'build_v3_chat_canonical_request_from_responses_payload',
    'build_v3_openai_chat_standard_request_from_chat_canonical',
  ]],
  [paths.mainlineMap, text.mainlineMap, [
    'chain_id: v3.protocol_conversion_field_parity',
    'binding_kind: protocol_field_parity_test_over_existing_relay_chain',
    'v3-protocol-field-parity-responses-chat-req-01',
    'v3-protocol-field-parity-openai-chat-same-protocol-01',
  ]],
  [paths.verificationMap, text.verificationMap, [
    'feature_id: v3.protocol_conversion_field_parity',
    'Responses request to OpenAI Chat provider wire preserves data-plane metadata/client_metadata/stop',
    'Anthropic thinking is preserved under Responses reasoning.thinking',
    'npm run test:v3-protocol-conversion-field-parity',
  ]],
  [paths.resourceMap, text.resourceMap, [
    'resource_id: v3.protocol_conversion.field_parity_contract',
    'owner_feature_id: v3.protocol_conversion_field_parity',
    'resource_kind: verification_manifest',
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

const pkg = JSON.parse(text.packageJson);
for (const scriptName of [
  'test:v3-protocol-conversion-field-parity',
  'verify:v3-protocol-conversion-field-parity',
  'test:v3-protocol-conversion-field-parity-red-fixtures',
]) {
  if (!pkg.scripts?.[scriptName]) failures.push(`${paths.packageJson}: missing script ${scriptName}`);
}

if (failures.length) {
  console.error('[verify:v3-protocol-conversion-field-parity] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('[verify:v3-protocol-conversion-field-parity] ok');

function requireText(source, owner, phrase) {
  if (!source.includes(phrase)) failures.push(`${owner}: missing ${phrase}`);
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
