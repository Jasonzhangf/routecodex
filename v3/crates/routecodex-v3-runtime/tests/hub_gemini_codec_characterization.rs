use routecodex_v3_runtime::{
    characterize_v3_gemini_client_input_to_hub_semantic,
    characterize_v3_gemini_hub_response_semantic_to_client_projection,
    characterize_v3_gemini_hub_semantic_to_provider_wire,
    characterize_v3_gemini_provider_raw_to_hub_response_semantic,
    collect_v3_gemini_request_generation_config_scalar_semantics,
    collect_v3_gemini_request_shape_branch_semantics,
    collect_v3_gemini_request_thinking_config_semantics,
    collect_v3_gemini_request_tool_config_semantics, V3GeminiChatGenerationConfigScalarSemantic,
    V3GeminiChatShapeBranchSemantic, V3GeminiChatThinkingConfigSemantic,
    V3GeminiChatToolChoicePolicy, V3GeminiChatToolConfigSemantic, V3GeminiCodecError,
    V3GeminiCodecStage, V3GeminiGenerationConfigScalarSemanticValue,
    V3GeminiThinkingConfigSemanticValue, V3GeminiToolConfigSemanticValue, V3HubEntryProtocol,
    V3HubProviderWireProtocol, V3HubTransportIntent,
};
use serde_json::json;

#[test]
fn request_preserves_contents_tools_and_function_response_pairs() {
    let request = json!({
        "model": "gemini-2.5-pro",
        "contents": [
            {"role": "user", "parts": [{"text": "lookup weather"}]},
            {"role": "model", "parts": [{"functionCall": {"name": "lookup", "args": {"city": "Tokyo"}}}]},
            {"role": "user", "parts": [{"functionResponse": {"name": "lookup", "response": {"forecast": "sunny"}}}]}
        ],
        "tools": [{"functionDeclarations": [{"name": "lookup", "parameters": {"type": "object"}}]}],
        "generationConfig": {"temperature": 0.2}
    });
    let semantic = characterize_v3_gemini_client_input_to_hub_semantic(
        request.clone(),
        V3HubEntryProtocol::Gemini,
        V3HubTransportIntent::Json,
    )
    .unwrap();
    assert_eq!(semantic.payload(), &request);
    assert_eq!(
        semantic.trace().stage,
        V3GeminiCodecStage::ClientInputToHubSemantic
    );
    let wire = characterize_v3_gemini_hub_semantic_to_provider_wire(semantic).unwrap();
    assert_eq!(wire.payload(), &request);
    assert_eq!(
        wire.trace().stage,
        V3GeminiCodecStage::HubSemanticToProviderWire
    );
}

#[test]
fn function_response_identity_pairing_is_not_normalization() {
    for request in [
        json!({"contents":[{"role":"user","parts":[{"functionResponse":{"response":{"x":1}}}]}]}),
        json!({"contents":[{"role":"user","parts":[{"functionResponse":{"name":"","response":{"x":1}}}]}]}),
        json!({"contents":[{"role":"user","parts":[{"functionResponse":{"name":"orphan","response":{"x":1}}}]}]}),
    ] {
        let semantic = characterize_v3_gemini_client_input_to_hub_semantic(
            request.clone(),
            V3HubEntryProtocol::Gemini,
            V3HubTransportIntent::Json,
        )
        .unwrap();
        assert_eq!(semantic.payload(), &request);
    }
}

fn gemini_media_request() -> serde_json::Value {
    json!({
        "contents": [{
            "role": "user",
            "parts": [
                {"inlineData": {"mimeType": "image/png", "data": "iVBORw0KGgo="}},
                {"fileData": {"mimeType": "application/pdf", "fileUri": "gs://bucket/spec.pdf"}}
            ]
        }]
    })
}

#[test]
fn gemini_inline_data_maps_to_chat_inline_media_data() {
    let semantics = collect_v3_gemini_request_shape_branch_semantics(
        &gemini_media_request(),
        V3HubEntryProtocol::Gemini,
    )
    .unwrap();
    assert!(semantics.iter().any(|semantic| semantic.chat_semantic
        == V3GeminiChatShapeBranchSemantic::ChatInlineMediaData
        && semantic.source_field == "request.contents[].parts[].inlineData.data"
        && semantic.value == "iVBORw0KGgo="));
}

#[test]
fn gemini_inline_mime_type_does_not_map_to_inline_media_data() {
    let semantics = collect_v3_gemini_request_shape_branch_semantics(
        &gemini_media_request(),
        V3HubEntryProtocol::Gemini,
    )
    .unwrap();
    assert!(!semantics.iter().any(|semantic| semantic.chat_semantic
        == V3GeminiChatShapeBranchSemantic::ChatInlineMediaData
        && semantic.source_field == "request.contents[].parts[].inlineData.mimeType"));
}

#[test]
fn gemini_inline_and_file_mime_type_maps_to_chat_media_mime_type() {
    let semantics = collect_v3_gemini_request_shape_branch_semantics(
        &gemini_media_request(),
        V3HubEntryProtocol::Gemini,
    )
    .unwrap();
    assert!(semantics.iter().any(|semantic| semantic.chat_semantic
        == V3GeminiChatShapeBranchSemantic::ChatMediaMimeType
        && semantic.source_field == "request.contents[].parts[].inlineData.mimeType"
        && semantic.value == "image/png"));
    assert!(semantics.iter().any(|semantic| semantic.chat_semantic
        == V3GeminiChatShapeBranchSemantic::ChatMediaMimeType
        && semantic.source_field == "request.contents[].parts[].fileData.mimeType"
        && semantic.value == "application/pdf"));
}

#[test]
fn gemini_file_uri_does_not_map_to_chat_media_mime_type() {
    let semantics = collect_v3_gemini_request_shape_branch_semantics(
        &gemini_media_request(),
        V3HubEntryProtocol::Gemini,
    )
    .unwrap();
    assert!(!semantics.iter().any(|semantic| semantic.chat_semantic
        == V3GeminiChatShapeBranchSemantic::ChatMediaMimeType
        && semantic.source_field == "request.contents[].parts[].fileData.fileUri"));
}

#[test]
fn gemini_file_uri_does_not_collapse_to_chat_file_file_id() {
    let semantics = collect_v3_gemini_request_shape_branch_semantics(
        &gemini_media_request(),
        V3HubEntryProtocol::Gemini,
    )
    .unwrap();
    assert!(!semantics
        .iter()
        .any(|semantic| semantic.chat_semantic == V3GeminiChatShapeBranchSemantic::ChatFileFileId));
}

#[test]
fn gemini_inline_media_data_does_not_collapse_to_chat_file_file_data_without_file_kind() {
    let semantics = collect_v3_gemini_request_shape_branch_semantics(
        &gemini_media_request(),
        V3HubEntryProtocol::Gemini,
    )
    .unwrap();
    assert!(!semantics.iter().any(
        |semantic| semantic.chat_semantic == V3GeminiChatShapeBranchSemantic::ChatFileFileData
    ));
}

#[test]
fn gemini_file_data_file_uri_maps_to_chat_file_file_url() {
    let semantics = collect_v3_gemini_request_shape_branch_semantics(
        &gemini_media_request(),
        V3HubEntryProtocol::Gemini,
    )
    .unwrap();
    assert!(semantics.iter().any(|semantic| semantic.chat_semantic
        == V3GeminiChatShapeBranchSemantic::ChatFileFileUrl
        && semantic.source_field == "request.contents[].parts[].fileData.fileUri"
        && semantic.value == "gs://bucket/spec.pdf"));
}

#[test]
fn gemini_inline_data_does_not_collapse_to_chat_file_file_url() {
    let semantics = collect_v3_gemini_request_shape_branch_semantics(
        &gemini_media_request(),
        V3HubEntryProtocol::Gemini,
    )
    .unwrap();
    assert!(!semantics.iter().any(|semantic| semantic.chat_semantic
        == V3GeminiChatShapeBranchSemantic::ChatFileFileUrl
        && semantic.source_field == "request.contents[].parts[].inlineData.data"));
}

#[test]
fn gemini_inline_or_file_data_does_not_collapse_to_chat_image_url_url() {
    let semantics = collect_v3_gemini_request_shape_branch_semantics(
        &gemini_media_request(),
        V3HubEntryProtocol::Gemini,
    )
    .unwrap();
    assert!(
        !semantics
            .iter()
            .any(|semantic| semantic.chat_semantic
                == V3GeminiChatShapeBranchSemantic::ChatImageUrlUrl)
    );
}

#[test]
fn gemini_shape_branch_semantics_do_not_mutate_provider_wire_payload() {
    let request = gemini_media_request();
    let semantic = characterize_v3_gemini_client_input_to_hub_semantic(
        request.clone(),
        V3HubEntryProtocol::Gemini,
        V3HubTransportIntent::Json,
    )
    .unwrap();
    let wire = characterize_v3_gemini_hub_semantic_to_provider_wire(semantic).unwrap();
    assert_eq!(wire.payload(), &request);
}

fn gemini_tool_config_request() -> serde_json::Value {
    json!({
        "contents": [{
            "role": "user",
            "parts": [{"text": "call search"}]
        }],
        "tools": [{
            "functionDeclarations": [
                {"name": "search", "parameters": {"type": "object"}},
                {"name": "write", "parameters": {"type": "object"}}
            ]
        }],
        "toolConfig": {
            "functionCallingConfig": {
                "mode": "ANY",
                "allowedFunctionNames": ["search"]
            }
        }
    })
}

#[test]
fn gemini_tool_config_mode_maps_to_chat_tool_choice_policy() {
    let semantics = collect_v3_gemini_request_tool_config_semantics(
        &gemini_tool_config_request(),
        V3HubEntryProtocol::Gemini,
    )
    .unwrap();
    assert!(semantics.iter().any(|semantic| semantic.chat_semantic
        == V3GeminiChatToolConfigSemantic::ChatToolChoicePolicy
        && semantic.source_field == "request.toolConfig.functionCallingConfig.mode"
        && matches!(
            &semantic.value,
            V3GeminiToolConfigSemanticValue::ToolChoicePolicy(
                V3GeminiChatToolChoicePolicy::Required
            )
        )));
}

#[test]
fn gemini_tool_config_allowed_function_names_maps_to_allowed_tool_choice_names() {
    let semantics = collect_v3_gemini_request_tool_config_semantics(
        &gemini_tool_config_request(),
        V3HubEntryProtocol::Gemini,
    )
    .unwrap();
    assert!(semantics.iter().any(|semantic| semantic.chat_semantic
        == V3GeminiChatToolConfigSemantic::ChatToolChoiceAllowedFunctionNames
        && semantic.source_field
            == "request.toolConfig.functionCallingConfig.allowedFunctionNames"
        && matches!(
            &semantic.value,
            V3GeminiToolConfigSemanticValue::AllowedFunctionNames(names)
                if names == &vec!["search".to_string()]
        )));
}

#[test]
fn gemini_tool_config_allowed_function_names_do_not_become_tool_declarations() {
    let semantics = collect_v3_gemini_request_tool_config_semantics(
        &gemini_tool_config_request(),
        V3HubEntryProtocol::Gemini,
    )
    .unwrap();
    assert!(!semantics.iter().any(|semantic| semantic.chat_semantic
        == V3GeminiChatToolConfigSemantic::ChatToolDeclarationName
        || semantic.source_field == "request.tools[].functionDeclarations[].name"));
}

#[test]
fn gemini_tool_config_mode_does_not_become_parallel_tool_calls_without_value_contract() {
    let semantics = collect_v3_gemini_request_tool_config_semantics(
        &gemini_tool_config_request(),
        V3HubEntryProtocol::Gemini,
    )
    .unwrap();
    assert!(!semantics
        .iter()
        .any(|semantic| semantic.chat_semantic
            == V3GeminiChatToolConfigSemantic::ChatParallelToolCalls));
}

#[test]
fn gemini_tool_config_malformed_allowed_function_names_fail_closed() {
    let err = collect_v3_gemini_request_tool_config_semantics(
        &json!({
            "contents": [{"role": "user", "parts": [{"text": "call search"}]}],
            "toolConfig": {
                "functionCallingConfig": {
                    "mode": "ANY",
                    "allowedFunctionNames": ["search", 7]
                }
            }
        }),
        V3HubEntryProtocol::Gemini,
    )
    .unwrap_err();
    assert!(matches!(
        err,
        V3GeminiCodecError::ToolConfigAllowedFunctionNameNotString { .. }
    ));
}

#[test]
fn gemini_tool_config_semantics_do_not_mutate_provider_wire_payload() {
    let request = gemini_tool_config_request();
    let semantic = characterize_v3_gemini_client_input_to_hub_semantic(
        request.clone(),
        V3HubEntryProtocol::Gemini,
        V3HubTransportIntent::Json,
    )
    .unwrap();
    let wire = characterize_v3_gemini_hub_semantic_to_provider_wire(semantic).unwrap();
    assert_eq!(wire.payload(), &request);
}

fn gemini_thinking_config_request() -> serde_json::Value {
    json!({
        "contents": [{
            "role": "user",
            "parts": [{"text": "think carefully"}]
        }],
        "generationConfig": {
            "thinkingConfig": {
                "includeThoughts": true,
                "thinkingBudget": 4096,
                "thinkingLevel": "HIGH"
            },
            "maxOutputTokens": 8192
        }
    })
}

#[test]
fn gemini_thinking_config_include_thoughts_maps_to_reasoning_visibility_request() {
    let semantics = collect_v3_gemini_request_thinking_config_semantics(
        &gemini_thinking_config_request(),
        V3HubEntryProtocol::Gemini,
    )
    .unwrap();
    assert!(semantics.iter().any(|semantic| semantic.chat_semantic
        == V3GeminiChatThinkingConfigSemantic::ChatReasoningIncludeThoughts
        && semantic.source_field == "request.generationConfig.thinkingConfig.includeThoughts"
        && matches!(
            semantic.value,
            V3GeminiThinkingConfigSemanticValue::IncludeThoughts(true)
        )));
}

#[test]
fn gemini_thinking_config_budget_maps_to_reasoning_budget_request() {
    let semantics = collect_v3_gemini_request_thinking_config_semantics(
        &gemini_thinking_config_request(),
        V3HubEntryProtocol::Gemini,
    )
    .unwrap();
    assert!(semantics.iter().any(|semantic| semantic.chat_semantic
        == V3GeminiChatThinkingConfigSemantic::ChatReasoningBudgetTokens
        && semantic.source_field == "request.generationConfig.thinkingConfig.thinkingBudget"
        && matches!(
            semantic.value,
            V3GeminiThinkingConfigSemanticValue::BudgetTokens(4096)
        )));
}

#[test]
fn gemini_thinking_config_level_maps_to_reasoning_effort_level_request() {
    let semantics = collect_v3_gemini_request_thinking_config_semantics(
        &gemini_thinking_config_request(),
        V3HubEntryProtocol::Gemini,
    )
    .unwrap();
    assert!(semantics.iter().any(|semantic| semantic.chat_semantic
        == V3GeminiChatThinkingConfigSemantic::ChatReasoningLevel
        && semantic.source_field == "request.generationConfig.thinkingConfig.thinkingLevel"
        && matches!(
            &semantic.value,
            V3GeminiThinkingConfigSemanticValue::Level(level) if level == "HIGH"
        )));
}

#[test]
fn gemini_thinking_budget_does_not_become_max_output_tokens() {
    let semantics = collect_v3_gemini_request_thinking_config_semantics(
        &gemini_thinking_config_request(),
        V3HubEntryProtocol::Gemini,
    )
    .unwrap();
    assert!(!semantics.iter().any(|semantic| semantic.chat_semantic
        == V3GeminiChatThinkingConfigSemantic::ChatMaxOutputTokens
        || semantic.source_field == "request.generationConfig.maxOutputTokens"));
}

#[test]
fn gemini_include_thoughts_does_not_become_response_reasoning_content() {
    let semantics = collect_v3_gemini_request_thinking_config_semantics(
        &gemini_thinking_config_request(),
        V3HubEntryProtocol::Gemini,
    )
    .unwrap();
    assert!(!semantics.iter().any(|semantic| semantic.chat_semantic
        == V3GeminiChatThinkingConfigSemantic::ChatResponseReasoningContent));
}

#[test]
fn gemini_thinking_level_does_not_collapse_to_numeric_budget() {
    let semantics = collect_v3_gemini_request_thinking_config_semantics(
        &gemini_thinking_config_request(),
        V3HubEntryProtocol::Gemini,
    )
    .unwrap();
    assert!(!semantics.iter().any(|semantic| semantic.source_field
        == "request.generationConfig.thinkingConfig.thinkingLevel"
        && semantic.chat_semantic
            == V3GeminiChatThinkingConfigSemantic::ChatReasoningBudgetTokens));
}

#[test]
fn gemini_thinking_config_malformed_fields_fail_closed() {
    let err = collect_v3_gemini_request_thinking_config_semantics(
        &json!({
            "contents": [{"role": "user", "parts": [{"text": "think"}]}],
            "generationConfig": {"thinkingConfig": {"thinkingBudget": "large"}}
        }),
        V3HubEntryProtocol::Gemini,
    )
    .unwrap_err();
    assert!(matches!(
        err,
        V3GeminiCodecError::ThinkingConfigBudgetNotInteger
    ));
}

#[test]
fn gemini_thinking_config_semantics_do_not_mutate_provider_wire_payload() {
    let request = gemini_thinking_config_request();
    let semantic = characterize_v3_gemini_client_input_to_hub_semantic(
        request.clone(),
        V3HubEntryProtocol::Gemini,
        V3HubTransportIntent::Json,
    )
    .unwrap();
    let wire = characterize_v3_gemini_hub_semantic_to_provider_wire(semantic).unwrap();
    assert_eq!(wire.payload(), &request);
}

fn gemini_generation_config_scalar_request() -> serde_json::Value {
    json!({
        "contents": [{"role": "user", "parts": [{"text": "sample"}]}],
        "generationConfig": {
            "maxOutputTokens": 4096,
            "temperature": 0.2,
            "topP": 0.8,
            "topK": 40,
            "stopSequences": ["END", "STOP"],
            "frequencyPenalty": 0.4,
            "presencePenalty": 0.7,
            "responseLogprobs": true,
            "logprobs": 5,
            "seed": 12345
        }
    })
}

#[test]
fn gemini_generation_config_temperature_maps_to_chat_temperature() {
    let semantics = collect_v3_gemini_request_generation_config_scalar_semantics(
        &gemini_generation_config_scalar_request(),
        V3HubEntryProtocol::Gemini,
    )
    .unwrap();
    assert!(semantics.iter().any(|semantic| semantic.chat_semantic
        == V3GeminiChatGenerationConfigScalarSemantic::ChatTemperature
        && semantic.source_field == "request.generationConfig.temperature"
        && matches!(semantic.value, V3GeminiGenerationConfigScalarSemanticValue::Number(value) if (value - 0.2).abs() < f64::EPSILON)));
}

#[test]
fn gemini_generation_config_top_p_maps_to_chat_top_p() {
    let semantics = collect_v3_gemini_request_generation_config_scalar_semantics(
        &gemini_generation_config_scalar_request(),
        V3HubEntryProtocol::Gemini,
    )
    .unwrap();
    assert!(semantics.iter().any(|semantic| semantic.chat_semantic
        == V3GeminiChatGenerationConfigScalarSemantic::ChatTopP
        && semantic.source_field == "request.generationConfig.topP"
        && matches!(semantic.value, V3GeminiGenerationConfigScalarSemanticValue::Number(value) if (value - 0.8).abs() < f64::EPSILON)));
}

#[test]
fn gemini_generation_config_top_k_maps_to_chat_top_k_extension() {
    let semantics = collect_v3_gemini_request_generation_config_scalar_semantics(
        &gemini_generation_config_scalar_request(),
        V3HubEntryProtocol::Gemini,
    )
    .unwrap();
    assert!(semantics.iter().any(|semantic| semantic.chat_semantic
        == V3GeminiChatGenerationConfigScalarSemantic::ChatTopK
        && semantic.source_field == "request.generationConfig.topK"
        && matches!(
            semantic.value,
            V3GeminiGenerationConfigScalarSemanticValue::Integer(40)
        )));
}

#[test]
fn gemini_generation_config_max_output_tokens_maps_to_chat_max_completion_tokens() {
    let semantics = collect_v3_gemini_request_generation_config_scalar_semantics(
        &gemini_generation_config_scalar_request(),
        V3HubEntryProtocol::Gemini,
    )
    .unwrap();
    assert!(semantics.iter().any(|semantic| semantic.chat_semantic
        == V3GeminiChatGenerationConfigScalarSemantic::ChatMaxCompletionTokens
        && semantic.source_field == "request.generationConfig.maxOutputTokens"
        && matches!(
            semantic.value,
            V3GeminiGenerationConfigScalarSemanticValue::Integer(4096)
        )));
}

#[test]
fn gemini_generation_config_stop_sequences_maps_to_chat_stop() {
    let semantics = collect_v3_gemini_request_generation_config_scalar_semantics(
        &gemini_generation_config_scalar_request(),
        V3HubEntryProtocol::Gemini,
    )
    .unwrap();
    assert!(semantics.iter().any(|semantic| semantic.chat_semantic
        == V3GeminiChatGenerationConfigScalarSemantic::ChatStop
        && semantic.source_field == "request.generationConfig.stopSequences"
        && matches!(
            &semantic.value,
            V3GeminiGenerationConfigScalarSemanticValue::StringList(values)
                if values == &vec!["END".to_string(), "STOP".to_string()]
        )));
}

#[test]
fn gemini_generation_config_frequency_penalty_maps_to_chat_frequency_penalty() {
    let semantics = collect_v3_gemini_request_generation_config_scalar_semantics(
        &gemini_generation_config_scalar_request(),
        V3HubEntryProtocol::Gemini,
    )
    .unwrap();
    assert!(semantics.iter().any(|semantic| semantic.chat_semantic
        == V3GeminiChatGenerationConfigScalarSemantic::ChatFrequencyPenalty
        && semantic.source_field == "request.generationConfig.frequencyPenalty"
        && matches!(semantic.value, V3GeminiGenerationConfigScalarSemanticValue::Number(value) if (value - 0.4).abs() < f64::EPSILON)));
}

#[test]
fn gemini_generation_config_presence_penalty_maps_to_chat_presence_penalty() {
    let semantics = collect_v3_gemini_request_generation_config_scalar_semantics(
        &gemini_generation_config_scalar_request(),
        V3HubEntryProtocol::Gemini,
    )
    .unwrap();
    assert!(semantics.iter().any(|semantic| semantic.chat_semantic
        == V3GeminiChatGenerationConfigScalarSemantic::ChatPresencePenalty
        && semantic.source_field == "request.generationConfig.presencePenalty"
        && matches!(semantic.value, V3GeminiGenerationConfigScalarSemanticValue::Number(value) if (value - 0.7).abs() < f64::EPSILON)));
}

#[test]
fn gemini_generation_config_response_logprobs_maps_to_chat_logprobs_request() {
    let semantics = collect_v3_gemini_request_generation_config_scalar_semantics(
        &gemini_generation_config_scalar_request(),
        V3HubEntryProtocol::Gemini,
    )
    .unwrap();
    assert!(semantics.iter().any(|semantic| semantic.chat_semantic
        == V3GeminiChatGenerationConfigScalarSemantic::ChatLogprobs
        && semantic.source_field == "request.generationConfig.responseLogprobs"
        && matches!(
            semantic.value,
            V3GeminiGenerationConfigScalarSemanticValue::Boolean(true)
        )));
}

#[test]
fn gemini_generation_config_logprobs_maps_to_chat_top_logprobs_count() {
    let semantics = collect_v3_gemini_request_generation_config_scalar_semantics(
        &gemini_generation_config_scalar_request(),
        V3HubEntryProtocol::Gemini,
    )
    .unwrap();
    assert!(semantics.iter().any(|semantic| semantic.chat_semantic
        == V3GeminiChatGenerationConfigScalarSemantic::ChatTopLogprobs
        && semantic.source_field == "request.generationConfig.logprobs"
        && matches!(
            semantic.value,
            V3GeminiGenerationConfigScalarSemanticValue::Integer(5)
        )));
}

#[test]
fn gemini_generation_config_seed_maps_to_chat_seed() {
    let semantics = collect_v3_gemini_request_generation_config_scalar_semantics(
        &gemini_generation_config_scalar_request(),
        V3HubEntryProtocol::Gemini,
    )
    .unwrap();
    assert!(semantics.iter().any(|semantic| semantic.chat_semantic
        == V3GeminiChatGenerationConfigScalarSemantic::ChatSeed
        && semantic.source_field == "request.generationConfig.seed"
        && matches!(
            semantic.value,
            V3GeminiGenerationConfigScalarSemanticValue::Integer(12345)
        )));
}

#[test]
fn gemini_generation_config_penalties_logprobs_and_seed_do_not_collapse() {
    let semantics = collect_v3_gemini_request_generation_config_scalar_semantics(
        &gemini_generation_config_scalar_request(),
        V3HubEntryProtocol::Gemini,
    )
    .unwrap();
    assert!(!semantics.iter().any(|semantic| semantic.source_field
        == "request.generationConfig.frequencyPenalty"
        && semantic.chat_semantic
            != V3GeminiChatGenerationConfigScalarSemantic::ChatFrequencyPenalty));
    assert!(!semantics.iter().any(|semantic| semantic.source_field
        == "request.generationConfig.topP"
        && semantic.chat_semantic == V3GeminiChatGenerationConfigScalarSemantic::ChatTopK));
    assert!(!semantics.iter().any(|semantic| semantic.source_field
        == "request.generationConfig.topK"
        && semantic.chat_semantic == V3GeminiChatGenerationConfigScalarSemantic::ChatTopP));
    assert!(!semantics.iter().any(|semantic| semantic.source_field
        == "request.generationConfig.maxOutputTokens"
        && semantic.chat_semantic
            == V3GeminiChatGenerationConfigScalarSemantic::ChatReasoningBudgetTokens));
    assert!(!semantics.iter().any(|semantic| semantic.source_field
        == "request.generationConfig.stopSequences"
        && semantic.chat_semantic == V3GeminiChatGenerationConfigScalarSemantic::ChatFinishReason));
    assert!(!semantics.iter().any(|semantic| semantic.source_field
        == "request.generationConfig.responseLogprobs"
        && semantic.chat_semantic == V3GeminiChatGenerationConfigScalarSemantic::ChatTopLogprobs));
    assert!(!semantics.iter().any(|semantic| semantic.source_field
        == "request.generationConfig.logprobs"
        && semantic.chat_semantic == V3GeminiChatGenerationConfigScalarSemantic::ChatLogprobs));
    assert!(!semantics.iter().any(|semantic| semantic.source_field
        == "request.generationConfig.seed"
        && semantic.chat_semantic != V3GeminiChatGenerationConfigScalarSemantic::ChatSeed));
}

#[test]
fn gemini_generation_config_scalar_malformed_fields_fail_closed() {
    let err = collect_v3_gemini_request_generation_config_scalar_semantics(
        &json!({
            "contents": [{"role": "user", "parts": [{"text": "sample"}]}],
            "generationConfig": {"logprobs": "five"}
        }),
        V3HubEntryProtocol::Gemini,
    )
    .unwrap_err();
    assert!(matches!(
        err,
        V3GeminiCodecError::GenerationConfigScalarNotInteger { .. }
    ));

    let err = collect_v3_gemini_request_generation_config_scalar_semantics(
        &json!({
            "contents": [{"role": "user", "parts": [{"text": "sample"}]}],
            "generationConfig": {"stopSequences": ["END", 7]}
        }),
        V3HubEntryProtocol::Gemini,
    )
    .unwrap_err();
    assert!(matches!(
        err,
        V3GeminiCodecError::GenerationConfigStopSequenceNotString { .. }
    ));
}

#[test]
fn gemini_generation_config_scalar_semantics_do_not_mutate_provider_wire_payload() {
    let request = gemini_generation_config_scalar_request();
    let semantic = characterize_v3_gemini_client_input_to_hub_semantic(
        request.clone(),
        V3HubEntryProtocol::Gemini,
        V3HubTransportIntent::Json,
    )
    .unwrap();
    let wire = characterize_v3_gemini_hub_semantic_to_provider_wire(semantic).unwrap();
    assert_eq!(wire.payload(), &request);
}

#[test]
fn json_response_preserves_candidates_usage_finish_reason_and_function_calls() {
    let response = json!({
        "candidates": [{
            "index": 0,
            "finishReason": "STOP",
            "content": {
                "role": "model",
                "parts": [
                    {"text": "result"},
                    {"functionCall": {"name": "lookup", "args": {"city": "Tokyo"}}}
                ]
            },
            "safetyRatings": []
        }],
        "usageMetadata": {"promptTokenCount": 10, "candidatesTokenCount": 4, "totalTokenCount": 14}
    });
    let semantic = characterize_v3_gemini_provider_raw_to_hub_response_semantic(
        response.clone(),
        V3HubProviderWireProtocol::Gemini,
        V3HubTransportIntent::Json,
    )
    .unwrap();
    assert_eq!(semantic.payload(), &response);
    assert_eq!(
        semantic.trace().stage,
        V3GeminiCodecStage::ProviderRawToHubResponseSemantic
    );
    let projected =
        characterize_v3_gemini_hub_response_semantic_to_client_projection(semantic).unwrap();
    assert_eq!(projected.payload(), &response);
    assert_eq!(
        projected.trace().stage,
        V3GeminiCodecStage::HubResponseSemanticToClientProjection
    );
}

#[test]
fn sse_characterization_preserves_individual_candidate_events_without_materialization() {
    let events = [
        json!({"candidates":[{"index":0,"content":{"role":"model","parts":[{"text":"hel"}]},"finishReason":null}]}),
        json!({"candidates":[{"index":0,"content":{"role":"model","parts":[{"text":"lo"}]},"finishReason":"STOP"}],"usageMetadata":{"totalTokenCount":8}}),
    ];
    for event in events {
        let semantic = characterize_v3_gemini_provider_raw_to_hub_response_semantic(
            event.clone(),
            V3HubProviderWireProtocol::Gemini,
            V3HubTransportIntent::Sse,
        )
        .unwrap();
        assert_eq!(semantic.payload(), &event);
        let projected =
            characterize_v3_gemini_hub_response_semantic_to_client_projection(semantic).unwrap();
        assert_eq!(projected.payload(), &event);
    }
}

#[test]
fn provider_error_protocol_and_side_channel_fail_closed() {
    let error = json!({"error":{"code":400,"message":"bad request","status":"INVALID_ARGUMENT"}});
    let semantic = characterize_v3_gemini_provider_raw_to_hub_response_semantic(
        error.clone(),
        V3HubProviderWireProtocol::Gemini,
        V3HubTransportIntent::Json,
    )
    .unwrap();
    assert_eq!(
        characterize_v3_gemini_hub_response_semantic_to_client_projection(semantic)
            .unwrap()
            .payload(),
        &error
    );
    assert!(matches!(
        characterize_v3_gemini_provider_raw_to_hub_response_semantic(
            json!({"error":{"code":400,"status":"INVALID_ARGUMENT"}}),
            V3HubProviderWireProtocol::Gemini,
            V3HubTransportIntent::Json,
        ),
        Err(V3GeminiCodecError::MalformedProviderError)
    ));
    assert!(matches!(
        characterize_v3_gemini_provider_raw_to_hub_response_semantic(
            json!({"candidates":[]}),
            V3HubProviderWireProtocol::Responses,
            V3HubTransportIntent::Json,
        ),
        Err(V3GeminiCodecError::ProviderProtocolNotGemini)
    ));
    for leaked in [
        "routecodex_internal",
        "metadata_center",
        "debug_snapshot",
        "provider_protocol",
        "resource_handle",
        "continuation_owner",
    ] {
        let mut payload = json!({"contents":[]});
        payload
            .as_object_mut()
            .unwrap()
            .insert(leaked.to_string(), json!(true));
        assert!(matches!(
            characterize_v3_gemini_client_input_to_hub_semantic(
                payload,
                V3HubEntryProtocol::Gemini,
                V3HubTransportIntent::Json
            ),
            Err(V3GeminiCodecError::SideChannelLeaked { .. })
        ));
    }
    assert!(matches!(
        characterize_v3_gemini_client_input_to_hub_semantic(
            json!({"contents":[]}),
            V3HubEntryProtocol::Responses,
            V3HubTransportIntent::Json,
        ),
        Err(V3GeminiCodecError::EntryProtocolNotGemini)
    ));
}
