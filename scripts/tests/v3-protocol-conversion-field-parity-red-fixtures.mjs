#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = process.cwd();
const verifier = resolve(repo, 'scripts/architecture/verify-v3-protocol-conversion-field-parity.mjs');
const files = [
  'docs/goals/v3-protocol-conversion-field-parity-test-design.md',
  'docs/goals/v3-protocol-semantic-field-gap-closeout-plan.md',
  'docs/architecture/reviews/v3-protocol-semantic-matrix-review.md',
  'docs/architecture/reviews/v3-protocol-semantic-field-matrix.yml',
  'docs/architecture/wiki/html/v3-protocol-semantic-field-matrix.html',
  'scripts/architecture/render-v3-protocol-semantic-field-matrix.mjs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/tests.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_openai_codec.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/request_outbound_format.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/provider_req_compat_06_provider_compat.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_codec.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime_codec.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/gemini_codec.rs',
  'v3/crates/routecodex-v3-runtime/tests/responses_relay_local_continuation_integration.rs',
  'v3/crates/routecodex-v3-runtime/tests/responses_relay_anthropic_provider_wire_integration.rs',
  'v3/crates/routecodex-v3-runtime/tests/anthropic_relay_runtime_integration.rs',
  'v3/crates/routecodex-v3-runtime/tests/hub_anthropic_codec_characterization.rs',
  'v3/crates/routecodex-v3-runtime/tests/openai_chat_relay_runtime_integration.rs',
  'v3/crates/routecodex-v3-runtime/tests/hub_gemini_codec_characterization.rs',
  'docs/architecture/v3-function-map.yml',
  'docs/architecture/v3-mainline-call-map.yml',
  'docs/architecture/v3-verification-map.yml',
  'docs/architecture/v3-resource-operation-map.yml',
  'package.json',
];

const cases = [



  {
    name: 'Responses target token/logprob normalizer stops mapping Chat max_completion_tokens',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/request_outbound_format.rs',
    from: 'let max_completion = row.remove("max_completion_tokens");',
    to: 'let max_completion = None;',
    diagnostic: /max_completion_tokens|openai_responses_provider_wire_maps_chat_token/u,
  },
  {
    name: 'Responses target token/logprob normalizer emits Chat logprobs boolean',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/request_outbound_format.rs',
    from: 'let logprobs_enabled = row\n        .remove("logprobs")',
    to: 'let logprobs_enabled = row\n        .get("logprobs")',
    diagnostic: /logprobs|top_logprobs/u,
  },
  {
    name: 'Responses target max token Rust test removed',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/tests.rs',
    from: 'openai_responses_provider_wire_maps_chat_token_and_logprob_pairs',
    to: 'openai_responses_provider_wire_maps_chat_token_removed',
    all: true,
    diagnostic: /openai_responses_provider_wire_maps_chat_token_and_logprob_pairs/u,
  },

  {
    name: 'Canonical extension registry omits an extension field',
    file: 'docs/architecture/reviews/v3-protocol-semantic-field-matrix.yml',
    from: '  - field: request.reasoning_summary_policy\n    semantic_id: request.reasoning_summary_policy\n',
    to: '  - field: request.reasoning_summary_policy_removed\n    semantic_id: request.reasoning_summary_policy_removed\n',
    diagnostic: /canonical_extension_registry|request\.reasoning_summary_policy/u,
  },
  {
    name: 'Canonical extension uses provider-shaped hierarchy',
    file: 'docs/architecture/reviews/v3-protocol-semantic-field-matrix.yml',
    from: '    - extended_openai_chat_field: request.reasoning_summary_policy\n      semantic_id: request.reasoning_summary_policy\n',
    to: '    - extended_openai_chat_field: request.reasoning.summary_policy\n      semantic_id: request.reasoning.summary_policy\n',
    diagnostic: /provider-shaped invented canonical extension hierarchy|request\.reasoning\.summary_policy/u,
  },

  {
    name: 'Extended Chat renames native OpenAI Chat field',
    file: 'docs/architecture/reviews/v3-protocol-semantic-field-matrix.yml',
    from: '    - extended_openai_chat_field: request.messages[].role\n      semantic_id: request.messages[].role\n',
    to: '    - extended_openai_chat_field: request.messages.role\n      semantic_id: request.messages[].role\n',
    diagnostic: /OpenAI Chat native field must not be renamed|request\.messages\.role/u,
  },
  {
    name: 'OpenAI Chat native field is mislabeled as extension_added',
    file: 'docs/architecture/reviews/v3-protocol-semantic-field-matrix.yml',
    from: '    - extended_openai_chat_field: request.audio.format\n      semantic_id: request.audio.format\n      direction: request\n      mapping_status: mapped\n',
    to: '    - extended_openai_chat_field: request.audio.format\n      semantic_id: request.audio.format\n      direction: request\n      mapping_status: extension_added\n',
    diagnostic: /native field must be mapped, not extension_added|request\.audio\.format/u,
  },
  {
    name: 'Added Chat extension field is mislabeled as mapped',
    file: 'docs/architecture/reviews/v3-protocol-semantic-field-matrix.yml',
    from: '    - extended_openai_chat_field: request.include\n      semantic_id: request.include\n      direction: request\n      mapping_status: extension_added\n',
    to: '    - extended_openai_chat_field: request.include\n      semantic_id: request.include\n      direction: request\n      mapping_status: mapped\n',
    diagnostic: /added Chat extension field must not use mapping_status=mapped|request\.include/u,
  },
  {
    name: 'OpenAI Chat native owner uses fake extension namespace',
    file: 'docs/architecture/reviews/v3-protocol-semantic-field-matrix.yml',
    from: '      semantic_owner: chat.canonical_semantics\n      current_impl: extension_declared\n',
    to: '      semantic_owner: chat.extensions.openai_chat\n      current_impl: extension_declared\n',
    diagnostic: /chat\.extensions\.openai_chat|semantic owner must not use/u,
  },
  {
    name: 'Extended OpenAI Chat superset uses source protocol namespace field',
    file: 'docs/architecture/reviews/v3-protocol-semantic-field-matrix.yml',
    from: '    - extended_openai_chat_field: request.include\n      semantic_id: request.include\n',
    to: '    - extended_openai_chat_field: openai_chat.ext.responses.request_include\n      semantic_id: request.include\n',
    diagnostic: /source protocol namespace|top-level request|openai_chat\.ext\.responses/u,
  },
  {
    name: 'Responses continuation field is collapsed into OpenAI Chat store',
    file: 'docs/architecture/reviews/v3-protocol-semantic-field-matrix.yml',
    from: '    - extended_openai_chat_field: request.previous_response_id\n      semantic_id: request.previous_response_id\n',
    to: '    - extended_openai_chat_field: request.store\n      semantic_id: request.previous_response_id\n',
    diagnostic: /duplicate extended_openai_chat_field request\.store|previous_response_id|OpenAI Chat source field appears/u,
  },
  {
    name: 'Extended OpenAI Chat superset drops an isolated Responses field mapping',
    file: 'docs/architecture/reviews/v3-protocol-semantic-field-matrix.yml',
    from: '        responses:\n          - request.include\n        openai_chat: []\n',
    to: '        responses: []\n        openai_chat: []\n',
    diagnostic: /request\.include|mapped to superset 0 times|source field/u,
  },
  {
    name: 'Extended OpenAI Chat superset duplicates semantic id',
    file: 'docs/architecture/reviews/v3-protocol-semantic-field-matrix.yml',
    from: '      semantic_id: request.include\n',
    to: '      semantic_id: request.audio.format\n',
    diagnostic: /duplicate semantic_id|request\.audio\.format/u,
  },
  {
    name: 'Semantic id reintroduces generated chat_native namespace',
    file: 'docs/architecture/reviews/v3-protocol-semantic-field-matrix.yml',
    from: '    - extended_openai_chat_field: request.audio.format\n      semantic_id: request.audio.format\n',
    to: '    - extended_openai_chat_field: request.audio.format\n      semantic_id: chat_native.request.audio.format\n',
    diagnostic: /semantic_id must equal|chat_native/u,
  },
  {
    name: 'Manual semantic translation group for tool arguments is renamed away',
    file: 'docs/architecture/reviews/v3-protocol-semantic-field-matrix.yml',
    from: '  - group_id: tool.call.arguments\n    standard_chat_field: request.messages[].tool_calls[].function.arguments\n',
    to: '  - group_id: tool.call.arguments_removed\n    standard_chat_field: request.messages[].tool_calls[].function.arguments\n',
    diagnostic: /missing manual semantic translation group tool\.call\.arguments/u,
  },
  {
    name: 'Tool call id group collapses function arguments',
    file: 'docs/architecture/reviews/v3-protocol-semantic-field-matrix.yml',
    from: '    - extended_openai_chat_field: request.messages[].tool_calls[].id\n      semantic_id: request.messages[].tool_calls[].id\n      direction: request\n      mapping_status: mapped\n      semantic_owner: chat.canonical_semantics\n      current_impl: covered\n      gap: none\n      equivalent_fields:\n        responses:\n          - request.input[].function_call.call_id\n          - request.input[].custom_tool_call.call_id\n',
    to: '    - extended_openai_chat_field: request.messages[].tool_calls[].id\n      semantic_id: request.messages[].tool_calls[].id\n      direction: request\n      mapping_status: mapped\n      semantic_owner: chat.canonical_semantics\n      current_impl: covered\n      gap: none\n      equivalent_fields:\n        responses:\n          - request.input[].function_call.call_id\n          - request.input[].function_call.arguments\n          - request.input[].custom_tool_call.call_id\n',
    diagnostic: /tool\.call\.id|must not collapse|function_call\.arguments/u,
  },
  {
    name: 'Tool result pairing id collapses output payload',
    file: 'docs/architecture/reviews/v3-protocol-semantic-field-matrix.yml',
    from: '    - extended_openai_chat_field: request.messages[].tool_call_id\n      semantic_id: request.messages[].tool_call_id\n      direction: request\n      mapping_status: mapped\n      semantic_owner: chat.canonical_semantics\n      current_impl: covered\n      gap: none\n      equivalent_fields:\n        responses:\n          - request.input[].function_call_output.call_id\n',
    to: '    - extended_openai_chat_field: request.messages[].tool_call_id\n      semantic_id: request.messages[].tool_call_id\n      direction: request\n      mapping_status: mapped\n      semantic_owner: chat.canonical_semantics\n      current_impl: covered\n      gap: none\n      equivalent_fields:\n        responses:\n          - request.input[].function_call_output.call_id\n          - request.input[].function_call_output.output\n',
    diagnostic: /tool\.result\.call_id|must not collapse|function_call_output\.output/u,
  },
  {
    name: 'Gemini functionResponse name collapses into tool_call_id',
    file: 'docs/architecture/reviews/v3-protocol-semantic-field-matrix.yml',
    from: '        gemini:\n          - request.contents[].parts[].functionResponse.id\n      source_classification: canonical_chat_fields\n',
    to: '        gemini:\n          - request.contents[].parts[].functionResponse.id\n          - request.contents[].parts[].functionResponse.name\n      source_classification: canonical_chat_fields\n',
    diagnostic: /tool\.result\.call_id|functionResponse\.name|must not collapse/u,
  },
  {
    name: 'Image URL semantic collapses Gemini inline MIME type',
    file: 'docs/architecture/reviews/v3-protocol-semantic-field-matrix.yml',
    from: '    - extended_openai_chat_field: request.messages[].content[].image_url.url\n      semantic_id: request.messages[].content[].image_url.url\n      direction: request\n      mapping_status: mapped\n      semantic_owner: chat.canonical_semantics\n      current_impl: shape_branch_gap\n      gap: Anthropic image.source requires source.type branch; Gemini inline/file data is extension-only\n      equivalent_fields:\n        responses:\n          - request.input[].input_image.image_url\n        openai_chat:\n          - request.messages[].content[].image_url.url\n        anthropic:\n          - request.messages[].content[].image.source\n        gemini: []\n',
    to: '    - extended_openai_chat_field: request.messages[].content[].image_url.url\n      semantic_id: request.messages[].content[].image_url.url\n      direction: request\n      mapping_status: mapped\n      semantic_owner: chat.canonical_semantics\n      current_impl: shape_branch_gap\n      gap: Anthropic image.source requires source.type branch; Gemini inline/file data is extension-only\n      equivalent_fields:\n        responses:\n          - request.input[].input_image.image_url\n        openai_chat:\n          - request.messages[].content[].image_url.url\n        anthropic:\n          - request.messages[].content[].image.source\n        gemini:\n          - request.contents[].parts[].inlineData.mimeType\n',
    diagnostic: /image_url\.url|inlineData\.mimeType|must not collapse/u,
  },
  {
    name: 'Shape branch contract drops negative cases',
    file: 'docs/architecture/reviews/v3-protocol-semantic-field-matrix.yml',
    from: '    shape_branch_cases:\n      positive:\n        - protocol: responses\n',
    to: '    shape_branch_cases_removed:\n      positive:\n        - protocol: responses\n',
    diagnostic: /content\.image_url|shape_branch_cases\.negative|must not be empty|missing anthropic branch/u,
  },
  {
    name: 'Shape branch contract assigns media branch to non-codec owner',
    file: 'docs/architecture/reviews/v3-protocol-semantic-field-matrix.yml',
    from: '          owner_file: v3/crates/routecodex-v3-runtime/src/hub_v1/gemini_codec.rs\n          required_test: gemini_inline_data_maps_to_chat_inline_media_data\n',
    to: '          owner_file: v3/crates/routecodex-v3-server/src/lib.rs\n          required_test: gemini_inline_data_maps_to_chat_inline_media_data\n',
    diagnostic: /content\.inline_media_data|adjacent Rust codec owner|v3-server/u,
  },
  {
    name: 'Anthropic shape branch helper removed from codec',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_codec.rs',
    from: 'collect_v3_anthropic_request_shape_branch_semantics',
    to: 'collect_v3_anthropic_request_branch_semantics_removed',
    all: true,
    diagnostic: /collect_v3_anthropic_request_shape_branch_semantics/u,
  },
  {
    name: 'Anthropic image URL collapses to inline media in codec owner',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_codec.rs',
    from: `"request.messages[].content[].image.source.url",
                            V3AnthropicChatShapeBranchSemantic::ChatImageUrlUrl,`,
    to: `"request.messages[].content[].image.source.url",
                            V3AnthropicChatShapeBranchSemantic::ChatInlineMediaData,`,
    diagnostic: /image\.source\.url.*ChatImageUrlUrl|image\.source\.url.*ChatInlineMediaData/u,
  },
  {
    name: 'Gemini shape branch helper removed from codec',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/gemini_codec.rs',
    from: 'collect_v3_gemini_request_shape_branch_semantics',
    to: 'collect_v3_gemini_request_branch_semantics_removed',
    all: true,
    diagnostic: /collect_v3_gemini_request_shape_branch_semantics/u,
  },
  {
    name: 'Gemini file URI collapses to image URL in codec owner',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/gemini_codec.rs',
    from: '"request.contents[].parts[].fileData.fileUri",\n                    V3GeminiChatShapeBranchSemantic::ChatFileFileUrl,',
    to: '"request.contents[].parts[].fileData.fileUri",\n                    V3GeminiChatShapeBranchSemantic::ChatImageUrlUrl,',
    diagnostic: /fileData\.fileUri.*ChatFileFileUrl|fileData\.fileUri.*ChatImageUrlUrl/u,
  },
  {
    name: 'Gemini shape branch required Rust test removed',
    file: 'v3/crates/routecodex-v3-runtime/tests/hub_gemini_codec_characterization.rs',
    from: 'gemini_inline_data_maps_to_chat_inline_media_data',
    to: 'gemini_inline_data_maps_to_chat_payload_removed',
    all: true,
    diagnostic: /gemini_inline_data_maps_to_chat_inline_media_data/u,
  },
  {
    name: 'Gemini allowedFunctionNames collapses into native tool_choice',
    file: 'docs/architecture/reviews/v3-protocol-semantic-field-matrix.yml',
    from: '        gemini:\n          - request.toolConfig.functionCallingConfig.mode\n      source_classification: canonical_chat_fields\n',
    to: '        gemini:\n          - request.toolConfig.functionCallingConfig.mode\n          - request.toolConfig.functionCallingConfig.allowedFunctionNames\n      source_classification: canonical_chat_fields\n',
    diagnostic: /request\.tool_choice.*allowedFunctionNames|source field gemini\.request\.toolConfig\.functionCallingConfig\.allowedFunctionNames mapped to superset/u,
  },
  {
    name: 'Gemini allowedFunctionNames extension row removed',
    file: 'docs/architecture/reviews/v3-protocol-semantic-field-matrix.yml',
    from: '    - extended_openai_chat_field: request.tool_choice.allowed_function_names\n      semantic_id: request.tool_choice.allowed_function_names\n',
    to: '    - extended_openai_chat_field: request.tool_choice.allowed_names_removed\n      semantic_id: request.tool_choice.allowed_names_removed\n',
    diagnostic: /request\.tool_choice\.allowed_function_names/u,
  },
  {
    name: 'Gemini thinkingConfig budget extension row removed',
    file: 'docs/architecture/reviews/v3-protocol-semantic-field-matrix.yml',
    from: '    - extended_openai_chat_field: request.reasoning_budget_tokens\n      semantic_id: request.reasoning_budget_tokens\n',
    to: '    - extended_openai_chat_field: request.reasoning_budget_removed\n      semantic_id: request.reasoning_budget_removed\n',
    diagnostic: /request\.reasoning_budget_tokens|thinkingBudget/u,
  },
  {
    name: 'Gemini includeThoughts collapses into native reasoning_effort',
    file: 'docs/architecture/reviews/v3-protocol-semantic-field-matrix.yml',
    from: '        gemini:\n          - request.generationConfig.thinkingConfig.thinkingLevel\n      source_classification: canonical_chat_fields\n',
    to: '        gemini:\n          - request.generationConfig.thinkingConfig.thinkingLevel\n          - request.generationConfig.thinkingConfig.includeThoughts\n      source_classification: canonical_chat_fields\n',
    diagnostic: /reasoning_effort.*includeThoughts|must not collapse Gemini request\.generationConfig\.thinkingConfig\.includeThoughts|source field gemini\.request\.generationConfig\.thinkingConfig\.includeThoughts mapped to superset/u,
  },
  {
    name: 'Gemini thinkingConfig helper removed from codec',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/gemini_codec.rs',
    from: 'collect_v3_gemini_request_thinking_config_semantics',
    to: 'collect_v3_gemini_request_thinking_config_removed',
    all: true,
    diagnostic: /collect_v3_gemini_request_thinking_config_semantics/u,
  },
  {
    name: 'Gemini generationConfig scalar helper removed from codec',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/gemini_codec.rs',
    from: 'collect_v3_gemini_request_generation_config_scalar_semantics',
    to: 'collect_v3_gemini_request_generation_config_scalar_removed',
    all: true,
    diagnostic: /collect_v3_gemini_request_generation_config_scalar_semantics/u,
  },
  {
    name: 'Gemini responseLogprobs collapses into top_logprobs in codec',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/gemini_codec.rs',
    from: '"request.generationConfig.responseLogprobs",\n        V3GeminiChatGenerationConfigScalarSemantic::ChatLogprobs,',
    to: '"request.generationConfig.responseLogprobs",\n        V3GeminiChatGenerationConfigScalarSemantic::ChatTopLogprobs,',
    diagnostic: /responseLogprobs.*ChatLogprobs|responseLogprobs.*ChatTopLogprobs/u,
  },
  {
    name: 'Gemini toolConfig helper removed from codec',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/gemini_codec.rs',
    from: 'collect_v3_gemini_request_tool_config_semantics',
    to: 'collect_v3_gemini_request_tcfg_semantics_removed',
    all: true,
    diagnostic: /collect_v3_gemini_request_tool_config_semantics/u,
  },
  {
    name: 'Gemini toolConfig mode collapses into parallel calls',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/gemini_codec.rs',
    from: '"request.toolConfig.functionCallingConfig.mode",\n                chat_semantic: V3GeminiChatToolConfigSemantic::ChatToolChoicePolicy,',
    to: '"request.toolConfig.functionCallingConfig.mode",\n                chat_semantic: V3GeminiChatToolConfigSemantic::ChatParallelToolCalls,',
    diagnostic: /functionCallingConfig\.mode.*ChatToolChoicePolicy|functionCallingConfig\.mode.*ChatParallelToolCalls/u,
  },
  {
    name: 'Manual semantic translation removes Anthropic transform',
    file: 'docs/architecture/reviews/v3-protocol-semantic-field-matrix.yml',
    from: '      transform: Anthropic tool_use.input object serializes to Chat function.arguments.\n',
    to: '      transform: \n',
    diagnostic: /tool\.call\.arguments|anthropic|missing manual transform/u,
  },
  {
    name: 'Manual audit statuses regress to pending_audit',
    file: 'docs/architecture/reviews/v3-protocol-semantic-field-matrix.yml',
    from: '      current_impl: extension_declared\n      gap: runtime mapping partial or extension-only gap\n',
    to: '      current_impl: pending_audit\n      gap: runtime mapping partial or extension-only gap\n',
    diagnostic: /pending_audit|precise audited statuses/u,
  },
  {
    name: 'Audit truth status count drifts from matrix',
    file: 'docs/architecture/reviews/v3-protocol-semantic-field-matrix.yml',
    from: '    extension_declared: 220\n',
    to: '    extension_declared: 219\n',
    diagnostic: /audited_status_counts\.extension_declared|must equal current_impl count/u,
  },
  {
    name: 'Source inventory only status is reintroduced after closeout',
    file: 'docs/architecture/reviews/v3-protocol-semantic-field-matrix.yml',
    from: '      current_impl: semantic_declared\n      gap: semantic owner declared; runtime conversion closeout pending\n',
    to: '      current_impl: source_inventory_only\n      gap: semantic owner declared; runtime conversion closeout pending\n',
    diagnostic: /source_inventory_only is closed|must not reappear/u,
  },
  {
    name: 'Textual truth section is removed from review document',
    file: 'docs/architecture/reviews/v3-protocol-semantic-matrix-review.md',
    from: '## Canonical textual truth for the field-matrix audit\n',
    to: '## Removed field-matrix truth\n',
    diagnostic: /Canonical textual truth for the field-matrix audit|v3-protocol-semantic-matrix-review/u,
  },
  {
    name: 'Textual truth audited extension count drifts from matrix',
    file: 'docs/architecture/reviews/v3-protocol-semantic-matrix-review.md',
    from: '| `extension_declared` | 220 | The OpenAI Chat extension field and semantic owner are declared, but runtime conversion closeout is not claimed. |\n',
    to: '| `extension_declared` | 221 | The OpenAI Chat extension field and semantic owner are declared, but runtime conversion closeout is not claimed. |\n',
    diagnostic: /`extension_declared` \| 220|v3-protocol-semantic-matrix-review/u,
  },
  {
    name: 'Gap audit drops runtime extension closeout row',
    file: 'docs/architecture/reviews/v3-protocol-semantic-field-matrix.yml',
    from: '    - gap_id: gap.runtime_extension_declared\n      category: runtime_closeout\n',
    to: '    - gap_id: gap.runtime_extension_declared_removed\n      category: runtime_closeout\n',
    diagnostic: /gap\.runtime_extension_declared|gap_audit/u,
  },
  {
    name: 'Implementation gap omits closeout status',
    file: 'docs/architecture/reviews/v3-protocol-semantic-field-matrix.yml',
    from: '    closeout_status: needs_runtime_goal\n    required_gate: npm run test:v3-protocol-conversion-field-parity\n  - id: gap.openai_chat.long_tail_fields\n',
    to: '  required_gate: npm run test:v3-protocol-conversion-field-parity\n- id: gap.openai_chat.long_tail_fields\n',
    diagnostic: /implementation_gaps\.gap\.gemini\.field_coverage|closeout_status|required_gate/u,
  },
  {
    name: 'Gap closeout plan drops recursive prompt guard',
    file: 'docs/goals/v3-protocol-semantic-field-gap-closeout-plan.md',
    from: 'must not generate another prompt for the same objective',
    to: 'may generate another prompt for the same objective',
    diagnostic: /must not generate another prompt for the same objective|gap-closeout-plan/u,
  },
  {
    name: 'Extended OpenAI Chat superset assigns business field to MetadataCenter',
    file: 'docs/architecture/reviews/v3-protocol-semantic-field-matrix.yml',
    from: '      semantic_owner: chat.extension_semantics\n      current_impl: extension_declared\n',
    to: '      semantic_owner: MetadataCenter\n      current_impl: extension_declared\n',
    diagnostic: /MetadataCenter|business semantic owner/u,
  },
  {
    name: 'Extended OpenAI Chat superset omits protocol extension association',
    file: 'docs/architecture/reviews/v3-protocol-semantic-field-matrix.yml',
    from: '      source_classification: protocol_specific_chat_extension_fields\n      chat_extension_association:\n        - extension_id: response_include_and_text\n          extension_owner: chat.extensions.responses.output_contract\n          current_impl: extension_declared\n',
    to: '      source_classification: protocol_specific_chat_extension_fields\n      chat_extension_association: []\n',
    diagnostic: /request\.top_logprobs missing Chat extension association response_include_and_text|extension association/u,
  },
  {
    name: 'HTML review surface is stale',
    file: 'docs/architecture/wiki/html/v3-protocol-semantic-field-matrix.html',
    from: 'data-review-surface="v3-protocol-semantic-field-matrix"',
    to: 'data-review-surface="v3-protocol-semantic-field-matrix-stale"',
    diagnostic: /v3-protocol-semantic-field-matrix\.html|out of sync|review-surface/u,
  },
  {
    name: 'HTML renderer drops semantic correspondence marker',
    file: 'scripts/architecture/render-v3-protocol-semantic-field-matrix.mjs',
    from: 'semantic-correspondence',
    to: 'semantic_correspondence_removed',
    all: true,
    diagnostic: /render-v3-protocol-semantic-field-matrix\.mjs|semantic-correspondence/u,
  },
  {
    name: 'Package render script is removed',
    file: 'package.json',
    from: '    "render:v3-protocol-semantic-field-matrix": "node scripts/architecture/render-v3-protocol-semantic-field-matrix.mjs",\n',
    to: '',
    diagnostic: /render:v3-protocol-semantic-field-matrix|package\.json/u,
  },
  {
    name: 'Full protocol matrix drops Gemini toolConfig field',
    file: 'docs/architecture/reviews/v3-protocol-semantic-field-matrix.yml',
    from: '      - field: toolConfig\n        semantic: tool.choice\n        chat_extension: canonical_chat\n        current_impl: partial\n',
    to: '',
    diagnostic: /toolConfig|field-matrix|gemini/u,
  },
  {
    name: 'Source inventory drops OpenAI Chat audio field',
    file: 'docs/architecture/reviews/v3-protocol-semantic-field-matrix.yml',
    from: '      - request.audio.format\n',
    to: '',
    diagnostic: /source_inventory|audio\.format|openai_chat/u,
  },
  {
    name: 'Semantic correspondence drops Gemini thinking budget mapping',
    file: 'docs/architecture/reviews/v3-protocol-semantic-field-matrix.yml',
    from: '  reasoning.request_budget_tokens:\n    canonical_path: chat.reasoning_budget_tokens\n    chat_extension: request.reasoning_budget_tokens\n    current_impl: partial\n',
    to: '  reasoning.request_budget_tokens_removed:\n    canonical_path: chat.reasoning_budget_tokens\n    chat_extension: request.reasoning_budget_tokens\n    current_impl: partial\n',
    diagnostic: /semantic_correspondence|thinkingConfig\.thinkingBudget|reasoning\.request_budget_tokens/u,
  },
  {
    name: 'OpenAI Chat client_metadata wrongly documented as provider-wire preserved',
    file: 'docs/goals/v3-protocol-conversion-field-parity-test-design.md',
    from: '`metadata` and `client_metadata` in client protocol bodies are data-plane fields. They must remain normal payload fields only when the target protocol can represent them; OpenAI Chat provider wire preserves `metadata` but strips non-standard `client_metadata`.',
    to: '`metadata` and `client_metadata` in client protocol bodies are data-plane fields. They must remain normal payload fields when the target protocol can represent them.',
    diagnostic: /client_metadata|OpenAI Chat provider wire/,
  },
  {
    name: 'Responses metadata dropped before Chat provider wire',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_openai_codec.rs',
    from: '        "metadata",\n        "client_metadata",\n        "stop",',
    to: '        "client_metadata",\n        "stop",',
    diagnostic: /metadata/,
  },
  {
    name: 'Responses client_metadata dropped before Chat provider wire',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_openai_codec.rs',
    from: '        "metadata",\n        "client_metadata",\n        "stop",',
    to: '        "metadata",\n        "stop",',
    diagnostic: /client_metadata/,
  },
  {
    name: 'Responses stop dropped before Chat provider wire',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_openai_codec.rs',
    from: '        "client_metadata",\n        "stop",',
    to: '        "client_metadata",',
    diagnostic: /stop/,
  },

  {
    name: 'Responses max_output_tokens sent directly to OpenAI Chat wire',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/request_outbound_format.rs',
    from: 'row.entry("max_completion_tokens".to_string())\n                .or_insert(max_output_tokens);',
    to: 'row.insert("max_output_tokens".to_string(), max_output_tokens);',
    diagnostic: /max_output_tokens|max_completion_tokens/,
  },
  {
    name: 'Responses Anthropic unsupported metadata silently forwarded',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_codec.rs',
    from: 'field: "metadata.unsupported",',
    to: 'field: "metadata",',
    diagnostic: /metadata\.unsupported/,
  },
  {
    name: 'OpenAI Chat response model dropped before Responses projection',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs',
    from: '    if let Some(model) = payload.get("model") {',
    to: '    if let Some(model) = payload.get("wire_model") {',
    diagnostic: /payload\.get\("model"\)/,
  },
  {
    name: 'OpenAI Chat created timestamp mapping dropped',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs',
    from: 'payload.get("created_at").or_else(|| payload.get("created"))',
    to: 'payload.get("created_at")',
    diagnostic: /created/,
  },
  {
    name: 'Anthropic thinking data-plane state compressed away',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_codec.rs',
    from: 'json!({"thinking":thinking})',
    to: 'json!({"effort":"medium","thinking":thinking})',
    diagnostic: /missing json|effort.*thinking|invent/u,
  },
  {
    name: 'Responses reasoning request config no longer maps to Anthropic thinking',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_codec.rs',
    from: 'responses_reasoning_policy_as_anthropic_system_marker(object)',
    to: 'None',
    diagnostic: /responses_reasoning_policy_as_anthropic_system_marker|routecodex_reasoning_request|summary_policy/,
  },
  {
    name: 'Anthropic provider compat drops original Responses reasoning surface',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/provider_req_compat_06_provider_compat.rs',
    from: 'V3HubProviderWireProtocol::Anthropic => {\n            if let Some(original_surface) =\n                build_v3_responses_original_input_surface_from_chat_canonical(\n                    input.provider_semantic_payload(),\n                    input.original_responses_payload(),\n                )',
    to: 'V3HubProviderWireProtocol::Anthropic => {\n            if let Some(original_surface) = None',
    diagnostic: /original_responses_payload|build_v3_responses_original_input_surface_from_chat_canonical|Anthropic/u,
  },
  {
    name: 'Original Responses reasoning surface is array-input only again',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/request_outbound_format.rs',
    from: 'original.get("input")?;',
    to: 'original.get("input").and_then(Value::as_array)?;',
    diagnostic: /responses_original_input_surface|original\.get\("input"\)|as_array/u,
  },
  {
    name: 'Responses to Anthropic provider-wire reasoning runtime test removed',
    file: 'v3/crates/routecodex-v3-runtime/tests/responses_relay_anthropic_provider_wire_integration.rs',
    from: 'responses_relay_reasoning_request_config_projects_anthropic_system_marker',
    to: 'responses_relay_reasoning_request_config_removed',
    all: true,
    diagnostic: /responses_relay_reasoning_request_config_projects_anthropic_system_marker/u,
  },
  {
    name: 'Responses string input to Anthropic provider-wire reasoning runtime test removed',
    file: 'v3/crates/routecodex-v3-runtime/tests/responses_relay_anthropic_provider_wire_integration.rs',
    from: 'responses_relay_string_input_reasoning_request_config_projects_anthropic_system_marker',
    to: 'responses_relay_string_input_reasoning_request_config_removed',
    all: true,
    diagnostic: /responses_relay_string_input_reasoning_request_config_projects_anthropic_system_marker/u,
  },
  {
    name: 'Responses summary/context must not synthesize OpenAI Chat reasoning_effort',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_openai_codec.rs',
    from: 'responses_reasoning_policy_as_target_valid_system_marker',
    to: 'responses_reasoning_policy_as_target_valid_system_marker_removed',
    all: true,
    diagnostic: /responses_reasoning_policy_as_target_valid_system_marker|routecodex_reasoning_request/u,
  },
  {
    name: 'OpenAI Chat provider-wire reasoning policy marker assertion removed',
    file: 'v3/crates/routecodex-v3-runtime/tests/responses_relay_local_continuation_integration.rs',
    from: '<routecodex_reasoning_request summary_policy=detailed></routecodex_reasoning_request>',
    to: '<reasoning-marker-removed>',
    diagnostic: /routecodex_reasoning_request|summary_policy/u,
  },
  {
    name: 'Malformed function arguments fail-fast parser removed',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime_codec.rs',
    from: 'parse_responses_function_call_arguments',
    to: 'parse_removed_arguments',
    all: true,
    diagnostic: /parse_responses_function_call_arguments/,
  },
  {
    name: 'OpenAI Chat same-protocol field matrix removed',
    file: 'v3/crates/routecodex-v3-runtime/tests/openai_chat_relay_runtime_integration.rs',
    from: 'openai_chat_same_protocol_field_parity_request_response_matrix',
    to: 'same_protocol_matrix_removed',
    all: true,
    diagnostic: /openai_chat_same_protocol_field_parity_request_response_matrix/,
  },
  {
    name: 'Protocol parity incorrectly claims MetadataCenter owner',
    file: 'docs/architecture/v3-function-map.yml',
    from: '      - v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime_codec.rs\n      - v3/crates/routecodex-v3-runtime/tests/responses_relay_local_continuation_integration.rs',
    to: '      - v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime_codec.rs\n      - MetadataCenter\n      - v3/crates/routecodex-v3-runtime/tests/responses_relay_local_continuation_integration.rs',
    diagnostic: /MetadataCenter|metadata_center/,
  },
  {
    name: 'Protocol parity source adds fallback branch',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_openai_codec.rs',
    from: 'pub(crate) fn build_v3_chat_canonical_request_from_responses_payload(\n    payload: &Value,\n) -> Result<Value, String> {',
    to: 'pub(crate) fn build_v3_chat_canonical_request_from_responses_payload(\n    payload: &Value,\n) -> Result<Value, String> {\n    let _fallback_forbidden = false;',
    diagnostic: /fallback/i,
  },
  {
    name: 'Provider outbound strips all metadata by substring',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/request_outbound_format.rs',
    from: 'fn is_provider_outbound_control_key(key: &str) -> bool {',
    to: 'fn is_provider_outbound_control_key(key: &str) -> bool {\n    if key.to_ascii_lowercase().contains("metadata") { return true; }',
    diagnostic: /contains\("metadata"\)|metadata/u,
  },
];

const failures = [];
for (const testCase of cases) {
  const root = mkdtempSync(join(tmpdir(), 'v3-protocol-parity-red-'));
  try {
    for (const file of files) copyFileInto(root, file);
    const target = resolve(root, testCase.file);
    const source = readFileSync(target, 'utf8');
    if (!source.includes(testCase.from)) throw new Error(`${testCase.name}: mutation source missing`);
    writeFileSync(
      target,
      testCase.all
        ? source.split(testCase.from).join(testCase.to)
        : source.replace(testCase.from, testCase.to),
    );
    const result = spawnSync(process.execPath, [verifier], { cwd: root, encoding: 'utf8' });
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    if (result.status === 0) failures.push(`${testCase.name}: verifier unexpectedly passed`);
    else if (!testCase.diagnostic.test(output)) failures.push(`${testCase.name}: wrong diagnostic: ${output.slice(-800)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (failures.length) {
  console.error('[test:v3-protocol-conversion-field-parity-red-fixtures] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(`[test:v3-protocol-conversion-field-parity-red-fixtures] ok (${cases.length} forbidden mutations rejected)`);

function copyFileInto(root, file) {
  const source = resolve(repo, file);
  const target = resolve(root, file);
  if (!existsSync(source)) throw new Error(`missing source ${file}`);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target);
}
