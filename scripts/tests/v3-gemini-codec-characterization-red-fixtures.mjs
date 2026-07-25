#!/usr/bin/env node
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = process.cwd();
const verifier = resolve(repoRoot, 'scripts/architecture/verify-v3-gemini-codec-characterization.mjs');
const fixtures = [
  ['hook registration', 'v3/crates/routecodex-v3-runtime/src/hub_v1/gemini_codec.rs', 'use super::{', 'use super::{ compile_v3_hub_v1_static_registry,', /forbidden.*compile_v3_hub_v1_static_registry/],
  ['protocol branch', 'v3/crates/routecodex-v3-runtime/src/hub_v1/gemini_codec.rs', 'V3HubEntryProtocol::Gemini', 'V3HubEntryProtocol::Responses', /missing V3HubEntryProtocol::Gemini|forbidden.*Responses/],
  ['side channel', 'v3/crates/routecodex-v3-runtime/src/hub_v1/gemini_codec.rs', '"metadata_center"', '"removed_center"', /missing metadata_center/],
  ['function response identity governance revival', 'v3/crates/routecodex-v3-runtime/src/hub_v1/gemini_codec.rs', 'fn validate_request(payload: &Value) -> Result<(), V3GeminiCodecError> {', 'fn validate_function_response_identity(functionResponse: &Value) { let _ = functionResponse; }\nfn validate_request(payload: &Value) -> Result<(), V3GeminiCodecError> {', /forbidden.*functionResponse|forbidden.*InvalidFunctionResponseIdentity/],
  ['SSE coverage', 'v3/crates/routecodex-v3-runtime/tests/hub_gemini_codec_characterization.rs', 'V3HubTransportIntent::Sse', 'V3HubTransportIntent::Json', /missing V3HubTransportIntent::Sse/],
  ['shape branch helper', 'v3/crates/routecodex-v3-runtime/src/hub_v1/gemini_codec.rs', 'collect_v3_gemini_request_shape_branch_semantics', 'collect_v3_gemini_request_branch_semantics_removed', /missing collect_v3_gemini_request_shape_branch_semantics/],
  ['file uri collapse to image url', 'v3/crates/routecodex-v3-runtime/src/hub_v1/gemini_codec.rs', '"request.contents[].parts[].fileData.fileUri",\n                    V3GeminiChatShapeBranchSemantic::ChatFileFileUrl,', '"request.contents[].parts[].fileData.fileUri",\n                    V3GeminiChatShapeBranchSemantic::ChatImageUrlUrl,', /fileData\.fileUri.*must map near ChatFileFileUrl|fileData\.fileUri.*must not collapse near ChatImageUrlUrl/],
  ['shape branch required test', 'v3/crates/routecodex-v3-runtime/tests/hub_gemini_codec_characterization.rs', 'gemini_inline_data_maps_to_chat_inline_media_data', 'gemini_inline_data_maps_to_chat_payload_removed', /missing gemini_inline_data_maps_to_chat_inline_media_data/],
  ['tool config helper', 'v3/crates/routecodex-v3-runtime/src/hub_v1/gemini_codec.rs', 'collect_v3_gemini_request_tool_config_semantics', 'collect_v3_gemini_request_tcfg_semantics_removed', /missing collect_v3_gemini_request_tool_config_semantics/],
  ['allowed function names collapse to declarations', 'v3/crates/routecodex-v3-runtime/src/hub_v1/gemini_codec.rs', '"request.toolConfig.functionCallingConfig.allowedFunctionNames",\n            chat_semantic: V3GeminiChatToolConfigSemantic::ChatToolChoiceAllowedFunctionNames,', '"request.toolConfig.functionCallingConfig.allowedFunctionNames",\n            chat_semantic: V3GeminiChatToolConfigSemantic::ChatToolDeclarationName,', /allowedFunctionNames.*must map near ChatToolChoiceAllowedFunctionNames|allowedFunctionNames.*must not collapse near ChatToolDeclarationName/],
  ['tool config mode collapse to parallel calls', 'v3/crates/routecodex-v3-runtime/src/hub_v1/gemini_codec.rs', '"request.toolConfig.functionCallingConfig.mode",\n                chat_semantic: V3GeminiChatToolConfigSemantic::ChatToolChoicePolicy,', '"request.toolConfig.functionCallingConfig.mode",\n                chat_semantic: V3GeminiChatToolConfigSemantic::ChatParallelToolCalls,', /functionCallingConfig\.mode.*must map near ChatToolChoicePolicy|functionCallingConfig\.mode.*must not collapse near ChatParallelToolCalls/],
  ['tool config required test', 'v3/crates/routecodex-v3-runtime/tests/hub_gemini_codec_characterization.rs', 'gemini_tool_config_allowed_function_names_maps_to_allowed_tool_choice_names', 'gemini_tool_config_allowed_names_removed', /missing gemini_tool_config_allowed_function_names_maps_to_allowed_tool_choice_names/],
  ['thinking config helper', 'v3/crates/routecodex-v3-runtime/src/hub_v1/gemini_codec.rs', 'collect_v3_gemini_request_thinking_config_semantics', 'collect_v3_gemini_request_tcfg_semantics_removed', /missing collect_v3_gemini_request_thinking_config_semantics/],
  ['thinking budget collapse to max output tokens', 'v3/crates/routecodex-v3-runtime/src/hub_v1/gemini_codec.rs', '"request.generationConfig.thinkingConfig.thinkingBudget",\n            chat_semantic: V3GeminiChatThinkingConfigSemantic::ChatReasoningBudgetTokens,', '"request.generationConfig.thinkingConfig.thinkingBudget",\n            chat_semantic: V3GeminiChatThinkingConfigSemantic::ChatMaxOutputTokens,', /thinkingConfig\.thinkingBudget.*must map near ChatReasoningBudgetTokens|thinkingConfig\.thinkingBudget.*must not collapse near ChatMaxOutputTokens/],
  ['include thoughts collapse to response reasoning', 'v3/crates/routecodex-v3-runtime/src/hub_v1/gemini_codec.rs', '"request.generationConfig.thinkingConfig.includeThoughts",\n            chat_semantic: V3GeminiChatThinkingConfigSemantic::ChatReasoningIncludeThoughts,', '"request.generationConfig.thinkingConfig.includeThoughts",\n            chat_semantic: V3GeminiChatThinkingConfigSemantic::ChatResponseReasoningContent,', /includeThoughts.*must map near ChatReasoningIncludeThoughts|includeThoughts.*must not collapse near ChatResponseReasoningContent/],
  ['thinking config required test', 'v3/crates/routecodex-v3-runtime/tests/hub_gemini_codec_characterization.rs', 'gemini_thinking_config_include_thoughts_maps_to_reasoning_visibility_request', 'gemini_thinking_config_include_removed', /missing gemini_thinking_config_include_thoughts_maps_to_reasoning_visibility_request/],
  ['generation scalar helper', 'v3/crates/routecodex-v3-runtime/src/hub_v1/gemini_codec.rs', 'collect_v3_gemini_request_generation_config_scalar_semantics', 'collect_v3_gemini_request_generation_scalar_removed', /missing collect_v3_gemini_request_generation_config_scalar_semantics/],
  ['frequency penalty collapse to presence penalty', 'v3/crates/routecodex-v3-runtime/src/hub_v1/gemini_codec.rs', '"request.generationConfig.frequencyPenalty",\n        V3GeminiChatGenerationConfigScalarSemantic::ChatFrequencyPenalty,', '"request.generationConfig.frequencyPenalty",\n        V3GeminiChatGenerationConfigScalarSemantic::ChatPresencePenalty,', /frequencyPenalty.*must map near ChatFrequencyPenalty|frequencyPenalty.*must not collapse near ChatPresencePenalty/],
  ['response logprobs collapse to top logprobs', 'v3/crates/routecodex-v3-runtime/src/hub_v1/gemini_codec.rs', '"request.generationConfig.responseLogprobs",\n        V3GeminiChatGenerationConfigScalarSemantic::ChatLogprobs,', '"request.generationConfig.responseLogprobs",\n        V3GeminiChatGenerationConfigScalarSemantic::ChatTopLogprobs,', /responseLogprobs.*must map near ChatLogprobs|responseLogprobs.*must not collapse near ChatTopLogprobs/],
  ['generation scalar required test', 'v3/crates/routecodex-v3-runtime/tests/hub_gemini_codec_characterization.rs', 'gemini_generation_config_response_logprobs_maps_to_chat_logprobs_request', 'gemini_generation_config_response_logprobs_removed', /missing gemini_generation_config_response_logprobs_maps_to_chat_logprobs_request/],
];
const failures = [];
for (const [name, relative, from, to, diagnostic] of fixtures) {
  const root = mkdtempSync(join(tmpdir(), 'routecodex-v3-gemini-codec-red-'));
  try {
    for (const item of ['v3', 'docs', 'scripts', 'package.json']) cpSync(resolve(repoRoot, item), join(root, item), { recursive: true, filter: source => !source.includes('/target/') });
    const target = join(root, relative);
    const source = readFileSync(target, 'utf8');
    if (!source.includes(from)) throw new Error(`${name}: fixture source missing`);
    writeFileSync(target, source.split(from).join(to));
    const result = spawnSync(process.execPath, [verifier], { cwd: root, encoding: 'utf8' });
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    if (result.status === 0) failures.push(`${name}: gate unexpectedly passed`);
    else if (!diagnostic.test(output)) failures.push(`${name}: wrong diagnostic: ${output.slice(-600)}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
if (failures.length) {
  console.error('[test:v3-gemini-codec-characterization-red-fixtures] failed');
  failures.forEach(failure => console.error(`- ${failure}`));
  process.exit(1);
}
console.log(`[test:v3-gemini-codec-characterization-red-fixtures] ok (${fixtures.length} forbidden mutations rejected)`);
