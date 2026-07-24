#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = process.cwd();
const sourcePath = 'v3/crates/routecodex-v3-runtime/src/hub_v1/gemini_codec.rs';
const source = readFileSync(resolve(root, sourcePath), 'utf8');
const tests = readFileSync(resolve(root, 'v3/crates/routecodex-v3-runtime/tests/hub_gemini_codec_characterization.rs'), 'utf8');
const failures = [];
const fail = message => failures.push(message);
const requireAll = (text, owner, phrases) => phrases.forEach(phrase => { if (!text.includes(phrase)) fail(`${owner}: missing ${phrase}`); });
const forbidAll = (text, owner, patterns) => patterns.forEach(pattern => { if (pattern.test(text)) fail(`${owner}: forbidden ${pattern}`); });
const requireNear = (text, owner, anchor, phrase, window = 260) => {
  const index = text.indexOf(anchor);
  if (index < 0) {
    fail(`${owner}: missing ${anchor}`);
    return;
  }
  const segment = text.slice(index, index + window);
  if (!segment.includes(phrase)) fail(`${owner}: ${anchor} must map near ${phrase}`);
};
const forbidNear = (text, owner, anchor, phrase, window = 260) => {
  const index = text.indexOf(anchor);
  if (index < 0) {
    fail(`${owner}: missing ${anchor}`);
    return;
  }
  const segment = text.slice(index, index + window);
  if (segment.includes(phrase)) fail(`${owner}: ${anchor} must not collapse near ${phrase}`);
};
function filesBelow(relative) {
  const files = [];
  for (const entry of readdirSync(resolve(root, relative))) {
    const path = join(relative, entry);
    if (statSync(resolve(root, path)).isDirectory()) files.push(...filesBelow(path));
    else if (entry.endsWith('.rs')) files.push(path);
  }
  return files;
}

requireAll(source, sourcePath, [
  'V3GeminiCodecStage', 'ClientInputToHubSemantic', 'HubSemanticToProviderWire',
  'ProviderRawToHubResponseSemantic', 'HubResponseSemanticToClientProjection',
  'V3HubEntryProtocol::Gemini', 'V3HubProviderWireProtocol::Gemini',
  'validate_content_shapes', 'validate_response', 'reject_side_channel_fields',
  'ContentsNotArray', 'MalformedProviderError', 'CandidatesNotArray',
  'routecodex_internal', 'metadata_center', 'debug_snapshot', 'provider_protocol',
  'resource_handle', 'continuation_owner',
  'collect_v3_gemini_request_shape_branch_semantics',
  'V3GeminiChatShapeBranchSemantic',
  'V3GeminiRequestShapeBranchSemantic',
  'request.contents[].parts[].inlineData.data',
  'request.contents[].parts[].inlineData.mimeType',
  'request.contents[].parts[].fileData.mimeType',
  'request.contents[].parts[].fileData.fileUri',
  'ChatInlineMediaData',
  'ChatMediaMimeType',
  'ChatFileFileUrl',
  'collect_v3_gemini_request_tool_config_semantics',
  'V3GeminiChatToolChoicePolicy',
  'V3GeminiChatToolConfigSemantic',
  'V3GeminiToolConfigSemanticValue',
  'request.toolConfig.functionCallingConfig.mode',
  'request.toolConfig.functionCallingConfig.allowedFunctionNames',
  'ChatToolChoicePolicy',
  'ChatToolChoiceAllowedFunctionNames',
  'ToolConfigAllowedFunctionNameNotString',
  'collect_v3_gemini_request_thinking_config_semantics',
  'V3GeminiChatThinkingConfigSemantic',
  'V3GeminiThinkingConfigSemanticValue',
  'request.generationConfig.thinkingConfig.includeThoughts',
  'request.generationConfig.thinkingConfig.thinkingBudget',
  'request.generationConfig.thinkingConfig.thinkingLevel',
  'ChatReasoningIncludeThoughts',
  'ChatReasoningBudgetTokens',
  'ChatReasoningLevel',
  'ThinkingConfigBudgetNotInteger',
]);
requireNear(source, sourcePath, '"request.contents[].parts[].inlineData.data"', 'ChatInlineMediaData');
requireNear(source, sourcePath, '"request.contents[].parts[].inlineData.mimeType"', 'ChatMediaMimeType');
requireNear(source, sourcePath, '"request.contents[].parts[].fileData.mimeType"', 'ChatMediaMimeType');
requireNear(source, sourcePath, '"request.contents[].parts[].fileData.fileUri"', 'ChatFileFileUrl');
forbidNear(source, sourcePath, '"request.contents[].parts[].inlineData.data"', 'ChatImageUrlUrl');
forbidNear(source, sourcePath, '"request.contents[].parts[].inlineData.data"', 'ChatFileFileData');
forbidNear(source, sourcePath, '"request.contents[].parts[].fileData.fileUri"', 'ChatImageUrlUrl');
forbidNear(source, sourcePath, '"request.contents[].parts[].fileData.fileUri"', 'ChatFileFileId');
requireNear(source, sourcePath, '"request.toolConfig.functionCallingConfig.mode"', 'ChatToolChoicePolicy');
requireNear(source, sourcePath, '"request.toolConfig.functionCallingConfig.allowedFunctionNames"', 'ChatToolChoiceAllowedFunctionNames');
forbidNear(source, sourcePath, '"request.toolConfig.functionCallingConfig.allowedFunctionNames"', 'ChatToolDeclarationName');
forbidNear(source, sourcePath, '"request.toolConfig.functionCallingConfig.mode"', 'ChatParallelToolCalls');
requireNear(source, sourcePath, '"request.generationConfig.thinkingConfig.includeThoughts"', 'ChatReasoningIncludeThoughts');
requireNear(source, sourcePath, '"request.generationConfig.thinkingConfig.thinkingBudget"', 'ChatReasoningBudgetTokens');
requireNear(source, sourcePath, '"request.generationConfig.thinkingConfig.thinkingLevel"', 'ChatReasoningLevel');
forbidNear(source, sourcePath, '"request.generationConfig.thinkingConfig.thinkingBudget"', 'ChatMaxOutputTokens');
forbidNear(source, sourcePath, '"request.generationConfig.thinkingConfig.includeThoughts"', 'ChatResponseReasoningContent');
forbidNear(source, sourcePath, '"request.generationConfig.thinkingConfig.thinkingLevel"', 'ChatReasoningBudgetTokens');
forbidAll(source, sourcePath, [
  /compile_v3_hub_v1_static_registry/, /compile_v3_hub_relay_(?:request|response)_hooks/,
  /V3HubStaticHookRegistry/, /V3HubRelay(?:Request|Response)Hook/, /routecodex-v3-server/,
  /V3HubEntryProtocol::(?:Responses|Anthropic|OpenAiChat)/, /fallback/i, /materializ/i,
  /metadata_center[\s\S]{0,120}payload\s*:/, /value\.clone\s*\(/,
  /InvalidFunctionResponseIdentity/, /\bBTreeSet\b/, /\bfunctionResponse\b/,
]);
requireAll(tests, 'focused Gemini codec tests', [
  'functionResponse', 'not_normalization', 'finishReason', 'usageMetadata', 'V3HubTransportIntent::Sse',
  'MalformedProviderError', 'SideChannelLeaked', 'ProviderProtocolNotGemini',
  'gemini_inline_data_maps_to_chat_inline_media_data',
  'gemini_inline_mime_type_does_not_map_to_inline_media_data',
  'gemini_inline_and_file_mime_type_maps_to_chat_media_mime_type',
  'gemini_file_uri_does_not_map_to_chat_media_mime_type',
  'gemini_file_uri_does_not_collapse_to_chat_file_file_id',
  'gemini_inline_media_data_does_not_collapse_to_chat_file_file_data_without_file_kind',
  'gemini_file_data_file_uri_maps_to_chat_file_file_url',
  'gemini_inline_data_does_not_collapse_to_chat_file_file_url',
  'gemini_inline_or_file_data_does_not_collapse_to_chat_image_url_url',
  'gemini_shape_branch_semantics_do_not_mutate_provider_wire_payload',
  'gemini_tool_config_mode_maps_to_chat_tool_choice_policy',
  'gemini_tool_config_allowed_function_names_maps_to_allowed_tool_choice_names',
  'gemini_tool_config_allowed_function_names_do_not_become_tool_declarations',
  'gemini_tool_config_mode_does_not_become_parallel_tool_calls_without_value_contract',
  'gemini_tool_config_malformed_allowed_function_names_fail_closed',
  'gemini_tool_config_semantics_do_not_mutate_provider_wire_payload',
  'gemini_thinking_config_include_thoughts_maps_to_reasoning_visibility_request',
  'gemini_thinking_config_budget_maps_to_reasoning_budget_request',
  'gemini_thinking_config_level_maps_to_reasoning_effort_level_request',
  'gemini_thinking_budget_does_not_become_max_output_tokens',
  'gemini_include_thoughts_does_not_become_response_reasoning_content',
  'gemini_thinking_level_does_not_collapse_to_numeric_budget',
  'gemini_thinking_config_malformed_fields_fail_closed',
  'gemini_thinking_config_semantics_do_not_mutate_provider_wire_payload',
]);
for (const path of [
  ...filesBelow('v3/crates/routecodex-v3-server/src'),
  ...filesBelow('v3/crates/routecodex-v3-provider-responses/src'),
  'v3/crates/routecodex-v3-runtime/src/hub_v1/resource_hooks.rs',
  'v3/crates/routecodex-v3-runtime/src/kernel.rs',
]) {
  const text = readFileSync(resolve(root, path), 'utf8');
  if (/V3GeminiCodecStage|characterize_v3_gemini/.test(text)) fail(`${path}: characterization must not register runtime wiring`);
}
for (const file of ['docs/architecture/v3-function-map.yml', 'docs/architecture/v3-verification-map.yml', 'docs/architecture/v3-mainline-call-map.yml']) {
  requireAll(readFileSync(resolve(root, file), 'utf8'), file, [
    'v3.protocol_gemini_codec_characterization', 'v3-protocol-gemini-01',
    'v3-protocol-gemini-02', 'v3-protocol-gemini-03', 'v3-protocol-gemini-04',
    'v3-protocol-gemini-shape-branch-01',
    'collect_v3_gemini_request_shape_branch_semantics',
    'v3-protocol-gemini-tool-config-01',
    'collect_v3_gemini_request_tool_config_semantics',
    'v3-protocol-gemini-thinking-config-01',
    'collect_v3_gemini_request_thinking_config_semantics',
  ]);
}
const scripts = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).scripts ?? {};
for (const script of ['test:v3-gemini-codec-characterization', 'verify:v3-gemini-codec-characterization', 'test:v3-gemini-codec-characterization-red-fixtures']) {
  if (!scripts[script]) fail(`package.json: missing script ${script}`);
}
if (failures.length) {
  console.error('[verify:v3-gemini-codec-characterization] failed');
  failures.forEach(failure => console.error(`- ${failure}`));
  process.exit(1);
}
console.log('[verify:v3-gemini-codec-characterization] ok');
