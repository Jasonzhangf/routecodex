use super::{V3HubEntryProtocol, V3HubProviderWireProtocol, V3HubTransportIntent};
use serde_json::{Map, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3GeminiCodecStage {
    ClientInputToHubSemantic,
    HubSemanticToProviderWire,
    ProviderRawToHubResponseSemantic,
    HubResponseSemanticToClientProjection,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3GeminiCodecTrace {
    pub stage: V3GeminiCodecStage,
    pub entry_protocol: V3HubEntryProtocol,
    pub provider_protocol: V3HubProviderWireProtocol,
    pub transport_intent: V3HubTransportIntent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3GeminiChatShapeBranchSemantic {
    ChatImageUrlUrl,
    ChatInlineMediaData,
    ChatMediaMimeType,
    ChatFileFileId,
    ChatFileFileData,
    ChatFileFileUrl,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3GeminiRequestShapeBranchSemantic {
    pub content_index: usize,
    pub part_index: usize,
    pub source_field: &'static str,
    pub chat_semantic: V3GeminiChatShapeBranchSemantic,
    pub value: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3GeminiChatToolChoicePolicy {
    Auto,
    Required,
    None,
    ProviderValidated,
    Unspecified,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3GeminiChatToolConfigSemantic {
    ChatToolChoicePolicy,
    ChatToolChoiceAllowedFunctionNames,
    ChatToolDeclarationName,
    ChatParallelToolCalls,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum V3GeminiToolConfigSemanticValue {
    ToolChoicePolicy(V3GeminiChatToolChoicePolicy),
    AllowedFunctionNames(Vec<String>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3GeminiRequestToolConfigSemantic {
    pub source_field: &'static str,
    pub chat_semantic: V3GeminiChatToolConfigSemantic,
    pub value: V3GeminiToolConfigSemanticValue,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3GeminiChatThinkingConfigSemantic {
    ChatReasoningIncludeThoughts,
    ChatReasoningBudgetTokens,
    ChatReasoningLevel,
    ChatMaxOutputTokens,
    ChatResponseReasoningContent,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum V3GeminiThinkingConfigSemanticValue {
    IncludeThoughts(bool),
    BudgetTokens(u64),
    Level(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3GeminiRequestThinkingConfigSemantic {
    pub source_field: &'static str,
    pub chat_semantic: V3GeminiChatThinkingConfigSemantic,
    pub value: V3GeminiThinkingConfigSemanticValue,
}

macro_rules! payload_wrapper {
    ($name:ident) => {
        #[derive(Debug, Clone, PartialEq)]
        pub struct $name {
            payload: Value,
            trace: V3GeminiCodecTrace,
        }

        impl $name {
            pub fn payload(&self) -> &Value {
                &self.payload
            }

            pub fn trace(&self) -> &V3GeminiCodecTrace {
                &self.trace
            }
        }
    };
}

payload_wrapper!(V3GeminiHubRequestSemantic);
payload_wrapper!(V3GeminiProviderWirePayload);
payload_wrapper!(V3GeminiHubResponseSemantic);
payload_wrapper!(V3GeminiClientProjection);

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum V3GeminiCodecError {
    #[error("Gemini codec accepts only the Gemini entry protocol")]
    EntryProtocolNotGemini,
    #[error("Gemini codec accepts only the Gemini provider protocol")]
    ProviderProtocolNotGemini,
    #[error("Gemini codec payload must be an object")]
    PayloadNotObject,
    #[error("Gemini codec payload leaked RouteCodex side-channel field: {field}")]
    SideChannelLeaked { field: &'static str },
    #[error("Gemini request contents must be an array")]
    ContentsNotArray,
    #[error("Gemini content parts must be an array")]
    PartsNotArray,
    #[error("Gemini inlineData branch must be an object")]
    InlineDataNotObject,
    #[error("Gemini fileData branch must be an object")]
    FileDataNotObject,
    #[error("Gemini shape branch field must be a string: {field}")]
    ShapeBranchFieldNotString { field: &'static str },
    #[error("Gemini toolConfig must be an object")]
    ToolConfigNotObject,
    #[error("Gemini functionCallingConfig must be an object")]
    FunctionCallingConfigNotObject,
    #[error("Gemini functionCallingConfig.mode must be a string")]
    ToolConfigModeNotString,
    #[error("Gemini functionCallingConfig.allowedFunctionNames must be an array")]
    ToolConfigAllowedFunctionNamesNotArray,
    #[error("Gemini functionCallingConfig.allowedFunctionNames must contain non-empty strings")]
    ToolConfigAllowedFunctionNameNotString { index: usize },
    #[error("Gemini generationConfig must be an object")]
    GenerationConfigNotObject,
    #[error("Gemini generationConfig.thinkingConfig must be an object")]
    ThinkingConfigNotObject,
    #[error("Gemini generationConfig.thinkingConfig.includeThoughts must be a boolean")]
    ThinkingConfigIncludeThoughtsNotBoolean,
    #[error(
        "Gemini generationConfig.thinkingConfig.thinkingBudget must be a non-negative integer"
    )]
    ThinkingConfigBudgetNotInteger,
    #[error("Gemini generationConfig.thinkingConfig.thinkingLevel must be a non-empty string")]
    ThinkingConfigLevelNotString,
    #[error("Gemini response candidates must be an array")]
    CandidatesNotArray,
    #[error("Gemini provider error requires error.message")]
    MalformedProviderError,
}

pub fn validate_v3_gemini_client_input_payload(
    payload: &Value,
    entry_protocol: V3HubEntryProtocol,
) -> Result<(), V3GeminiCodecError> {
    if entry_protocol != V3HubEntryProtocol::Gemini {
        return Err(V3GeminiCodecError::EntryProtocolNotGemini);
    }
    validate_request(payload)
}

pub fn validate_v3_gemini_provider_response_payload(
    payload: &Value,
    provider_protocol: V3HubProviderWireProtocol,
) -> Result<(), V3GeminiCodecError> {
    if provider_protocol != V3HubProviderWireProtocol::Gemini {
        return Err(V3GeminiCodecError::ProviderProtocolNotGemini);
    }
    validate_response(payload)
}

pub fn characterize_v3_gemini_client_input_to_hub_semantic(
    payload: Value,
    entry_protocol: V3HubEntryProtocol,
    transport_intent: V3HubTransportIntent,
) -> Result<V3GeminiHubRequestSemantic, V3GeminiCodecError> {
    validate_v3_gemini_client_input_payload(&payload, entry_protocol)?;
    Ok(V3GeminiHubRequestSemantic {
        payload,
        trace: trace(
            V3GeminiCodecStage::ClientInputToHubSemantic,
            transport_intent,
        ),
    })
}

pub fn collect_v3_gemini_request_shape_branch_semantics(
    payload: &Value,
    entry_protocol: V3HubEntryProtocol,
) -> Result<Vec<V3GeminiRequestShapeBranchSemantic>, V3GeminiCodecError> {
    validate_v3_gemini_client_input_payload(payload, entry_protocol)?;
    let contents = payload
        .get("contents")
        .and_then(Value::as_array)
        .ok_or(V3GeminiCodecError::ContentsNotArray)?;
    let mut semantics = Vec::new();
    for (content_index, content) in contents.iter().enumerate() {
        let parts = content
            .get("parts")
            .and_then(Value::as_array)
            .ok_or(V3GeminiCodecError::PartsNotArray)?;
        for (part_index, part) in parts.iter().enumerate() {
            let part_object = require_object(part)?;
            if let Some(inline_data) = part_object.get("inlineData") {
                let inline_object = inline_data
                    .as_object()
                    .ok_or(V3GeminiCodecError::InlineDataNotObject)?;
                push_optional_branch_string(
                    &mut semantics,
                    content_index,
                    part_index,
                    inline_object,
                    "data",
                    "request.contents[].parts[].inlineData.data",
                    V3GeminiChatShapeBranchSemantic::ChatInlineMediaData,
                )?;
                push_optional_branch_string(
                    &mut semantics,
                    content_index,
                    part_index,
                    inline_object,
                    "mimeType",
                    "request.contents[].parts[].inlineData.mimeType",
                    V3GeminiChatShapeBranchSemantic::ChatMediaMimeType,
                )?;
            }
            if let Some(file_data) = part_object.get("fileData") {
                let file_object = file_data
                    .as_object()
                    .ok_or(V3GeminiCodecError::FileDataNotObject)?;
                push_optional_branch_string(
                    &mut semantics,
                    content_index,
                    part_index,
                    file_object,
                    "mimeType",
                    "request.contents[].parts[].fileData.mimeType",
                    V3GeminiChatShapeBranchSemantic::ChatMediaMimeType,
                )?;
                push_optional_branch_string(
                    &mut semantics,
                    content_index,
                    part_index,
                    file_object,
                    "fileUri",
                    "request.contents[].parts[].fileData.fileUri",
                    V3GeminiChatShapeBranchSemantic::ChatFileFileUrl,
                )?;
            }
        }
    }
    Ok(semantics)
}

pub fn collect_v3_gemini_request_tool_config_semantics(
    payload: &Value,
    entry_protocol: V3HubEntryProtocol,
) -> Result<Vec<V3GeminiRequestToolConfigSemantic>, V3GeminiCodecError> {
    validate_v3_gemini_client_input_payload(payload, entry_protocol)?;
    let object = require_object(payload)?;
    let Some(tool_config) = object.get("toolConfig") else {
        return Ok(Vec::new());
    };
    let tool_config = tool_config
        .as_object()
        .ok_or(V3GeminiCodecError::ToolConfigNotObject)?;
    let Some(function_calling_config) = tool_config.get("functionCallingConfig") else {
        return Ok(Vec::new());
    };
    let function_calling_config = function_calling_config
        .as_object()
        .ok_or(V3GeminiCodecError::FunctionCallingConfigNotObject)?;

    let mut semantics = Vec::new();
    if let Some(raw_mode) = function_calling_config.get("mode") {
        let mode = raw_mode
            .as_str()
            .ok_or(V3GeminiCodecError::ToolConfigModeNotString)?;
        if !mode.is_empty() {
            semantics.push(V3GeminiRequestToolConfigSemantic {
                source_field: "request.toolConfig.functionCallingConfig.mode",
                chat_semantic: V3GeminiChatToolConfigSemantic::ChatToolChoicePolicy,
                value: V3GeminiToolConfigSemanticValue::ToolChoicePolicy(
                    map_gemini_function_calling_mode_to_chat_tool_choice_policy(mode),
                ),
            });
        }
    }
    if let Some(raw_allowed_names) = function_calling_config.get("allowedFunctionNames") {
        let allowed_names = raw_allowed_names
            .as_array()
            .ok_or(V3GeminiCodecError::ToolConfigAllowedFunctionNamesNotArray)?;
        let mut names = Vec::with_capacity(allowed_names.len());
        for (index, raw_name) in allowed_names.iter().enumerate() {
            let Some(name) = raw_name.as_str().filter(|name| !name.is_empty()) else {
                return Err(V3GeminiCodecError::ToolConfigAllowedFunctionNameNotString { index });
            };
            names.push(name.to_owned());
        }
        semantics.push(V3GeminiRequestToolConfigSemantic {
            source_field: "request.toolConfig.functionCallingConfig.allowedFunctionNames",
            chat_semantic: V3GeminiChatToolConfigSemantic::ChatToolChoiceAllowedFunctionNames,
            value: V3GeminiToolConfigSemanticValue::AllowedFunctionNames(names),
        });
    }
    Ok(semantics)
}

pub fn collect_v3_gemini_request_thinking_config_semantics(
    payload: &Value,
    entry_protocol: V3HubEntryProtocol,
) -> Result<Vec<V3GeminiRequestThinkingConfigSemantic>, V3GeminiCodecError> {
    validate_v3_gemini_client_input_payload(payload, entry_protocol)?;
    let object = require_object(payload)?;
    let Some(generation_config) = object.get("generationConfig") else {
        return Ok(Vec::new());
    };
    let generation_config = generation_config
        .as_object()
        .ok_or(V3GeminiCodecError::GenerationConfigNotObject)?;
    let Some(thinking_config) = generation_config.get("thinkingConfig") else {
        return Ok(Vec::new());
    };
    let thinking_config = thinking_config
        .as_object()
        .ok_or(V3GeminiCodecError::ThinkingConfigNotObject)?;

    let mut semantics = Vec::new();
    if let Some(raw_include_thoughts) = thinking_config.get("includeThoughts") {
        let include_thoughts = raw_include_thoughts
            .as_bool()
            .ok_or(V3GeminiCodecError::ThinkingConfigIncludeThoughtsNotBoolean)?;
        semantics.push(V3GeminiRequestThinkingConfigSemantic {
            source_field: "request.generationConfig.thinkingConfig.includeThoughts",
            chat_semantic: V3GeminiChatThinkingConfigSemantic::ChatReasoningIncludeThoughts,
            value: V3GeminiThinkingConfigSemanticValue::IncludeThoughts(include_thoughts),
        });
    }
    if let Some(raw_budget) = thinking_config.get("thinkingBudget") {
        let budget = raw_budget
            .as_u64()
            .ok_or(V3GeminiCodecError::ThinkingConfigBudgetNotInteger)?;
        semantics.push(V3GeminiRequestThinkingConfigSemantic {
            source_field: "request.generationConfig.thinkingConfig.thinkingBudget",
            chat_semantic: V3GeminiChatThinkingConfigSemantic::ChatReasoningBudgetTokens,
            value: V3GeminiThinkingConfigSemanticValue::BudgetTokens(budget),
        });
    }
    if let Some(raw_level) = thinking_config.get("thinkingLevel") {
        let Some(level) = raw_level.as_str().filter(|level| !level.is_empty()) else {
            return Err(V3GeminiCodecError::ThinkingConfigLevelNotString);
        };
        semantics.push(V3GeminiRequestThinkingConfigSemantic {
            source_field: "request.generationConfig.thinkingConfig.thinkingLevel",
            chat_semantic: V3GeminiChatThinkingConfigSemantic::ChatReasoningLevel,
            value: V3GeminiThinkingConfigSemanticValue::Level(level.to_owned()),
        });
    }
    Ok(semantics)
}

pub fn characterize_v3_gemini_hub_semantic_to_provider_wire(
    semantic: V3GeminiHubRequestSemantic,
) -> Result<V3GeminiProviderWirePayload, V3GeminiCodecError> {
    validate_request(&semantic.payload)?;
    Ok(V3GeminiProviderWirePayload {
        payload: semantic.payload,
        trace: trace(
            V3GeminiCodecStage::HubSemanticToProviderWire,
            semantic.trace.transport_intent,
        ),
    })
}

pub fn characterize_v3_gemini_provider_raw_to_hub_response_semantic(
    payload: Value,
    provider_protocol: V3HubProviderWireProtocol,
    transport_intent: V3HubTransportIntent,
) -> Result<V3GeminiHubResponseSemantic, V3GeminiCodecError> {
    validate_v3_gemini_provider_response_payload(&payload, provider_protocol)?;
    Ok(V3GeminiHubResponseSemantic {
        payload,
        trace: trace(
            V3GeminiCodecStage::ProviderRawToHubResponseSemantic,
            transport_intent,
        ),
    })
}

pub fn characterize_v3_gemini_hub_response_semantic_to_client_projection(
    semantic: V3GeminiHubResponseSemantic,
) -> Result<V3GeminiClientProjection, V3GeminiCodecError> {
    validate_response(&semantic.payload)?;
    Ok(V3GeminiClientProjection {
        payload: semantic.payload,
        trace: trace(
            V3GeminiCodecStage::HubResponseSemanticToClientProjection,
            semantic.trace.transport_intent,
        ),
    })
}

fn trace(stage: V3GeminiCodecStage, transport_intent: V3HubTransportIntent) -> V3GeminiCodecTrace {
    V3GeminiCodecTrace {
        stage,
        entry_protocol: V3HubEntryProtocol::Gemini,
        provider_protocol: V3HubProviderWireProtocol::Gemini,
        transport_intent,
    }
}

fn validate_request(payload: &Value) -> Result<(), V3GeminiCodecError> {
    reject_side_channel_fields(payload)?;
    let contents = payload
        .get("contents")
        .and_then(Value::as_array)
        .ok_or(V3GeminiCodecError::ContentsNotArray)?;
    validate_content_shapes(contents)
}

fn validate_content_shapes(contents: &[Value]) -> Result<(), V3GeminiCodecError> {
    for content in contents {
        content
            .get("parts")
            .and_then(Value::as_array)
            .ok_or(V3GeminiCodecError::PartsNotArray)?;
    }
    Ok(())
}

fn map_gemini_function_calling_mode_to_chat_tool_choice_policy(
    mode: &str,
) -> V3GeminiChatToolChoicePolicy {
    match mode {
        "AUTO" => V3GeminiChatToolChoicePolicy::Auto,
        "ANY" => V3GeminiChatToolChoicePolicy::Required,
        "NONE" => V3GeminiChatToolChoicePolicy::None,
        "VALIDATED" => V3GeminiChatToolChoicePolicy::ProviderValidated,
        "MODE_UNSPECIFIED" => V3GeminiChatToolChoicePolicy::Unspecified,
        _ => V3GeminiChatToolChoicePolicy::Unspecified,
    }
}

fn push_optional_branch_string(
    semantics: &mut Vec<V3GeminiRequestShapeBranchSemantic>,
    content_index: usize,
    part_index: usize,
    branch_object: &Map<String, Value>,
    provider_field: &'static str,
    source_field: &'static str,
    chat_semantic: V3GeminiChatShapeBranchSemantic,
) -> Result<(), V3GeminiCodecError> {
    let Some(raw) = branch_object.get(provider_field) else {
        return Ok(());
    };
    let value = raw
        .as_str()
        .ok_or(V3GeminiCodecError::ShapeBranchFieldNotString {
            field: source_field,
        })?;
    if value.is_empty() {
        return Ok(());
    }
    semantics.push(V3GeminiRequestShapeBranchSemantic {
        content_index,
        part_index,
        source_field,
        chat_semantic,
        value: value.to_owned(),
    });
    Ok(())
}

fn validate_response(payload: &Value) -> Result<(), V3GeminiCodecError> {
    reject_side_channel_fields(payload)?;
    if payload.get("error").is_some() {
        return validate_provider_error(payload);
    }
    let candidates = payload
        .get("candidates")
        .and_then(Value::as_array)
        .ok_or(V3GeminiCodecError::CandidatesNotArray)?;
    for candidate in candidates {
        let parts = candidate
            .get("content")
            .and_then(|content| content.get("parts"))
            .and_then(Value::as_array)
            .ok_or(V3GeminiCodecError::PartsNotArray)?;
        for part in parts {
            require_object(part)?;
        }
    }
    Ok(())
}

fn validate_provider_error(payload: &Value) -> Result<(), V3GeminiCodecError> {
    let valid = payload
        .get("error")
        .and_then(Value::as_object)
        .and_then(|error| error.get("message"))
        .and_then(Value::as_str)
        .is_some_and(|message| !message.is_empty());
    if valid {
        Ok(())
    } else {
        Err(V3GeminiCodecError::MalformedProviderError)
    }
}

fn reject_side_channel_fields(payload: &Value) -> Result<(), V3GeminiCodecError> {
    for key in require_object(payload)?.keys() {
        let label = match key.as_str() {
            "routecodex_internal" => Some("routecodex_internal"),
            "metadata_center" => Some("metadata_center"),
            "debug_snapshot" => Some("debug_snapshot"),
            "provider_protocol" => Some("provider_protocol"),
            "resource_handle" => Some("resource_handle"),
            "continuation_owner" => Some("continuation_owner"),
            _ => None,
        };
        if let Some(field) = label {
            return Err(V3GeminiCodecError::SideChannelLeaked { field });
        }
    }
    Ok(())
}

fn require_object(payload: &Value) -> Result<&Map<String, Value>, V3GeminiCodecError> {
    payload
        .as_object()
        .ok_or(V3GeminiCodecError::PayloadNotObject)
}
