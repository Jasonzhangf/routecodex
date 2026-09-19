use super::web_search_hop::{first_local_websearch_tool_call, hosted_web_search_result_text};
use super::{
    V3HubRelayRequestError, V3HubRelayRequestHookEvent, V3HubRelayResponseError,
    V3HubRelayResponseHookProfile, V3HubRespInbound02Normalized, V3ServerToolName,
    V3WebSearchCenterPhase, V3WebSearchCenterState,
};
use serde_json::{json, Value};
use servertool_core::cli_contract::{
    build_client_exec_cli_projection_output, parse_servertool_cli_projection_tool_arguments,
    ServertoolCliProjectionToolArgumentsInput,
};
use servertool_core::outcome_contract::is_client_exec_cli_projection;
use std::collections::BTreeSet;
use std::sync::Arc;

/// Typed WebSearch hook result. `metadata` is provider-owned usage data that
/// the existing response projection may consume; it is not control state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3WebSearchResult {
    pub call_id: String,
    pub status: V3WebSearchResultStatus,
    pub content: Option<String>,
    pub sources: Vec<V3WebSearchSource>,
    pub metadata: Option<Value>,
    pub error: Option<V3WebSearchError>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum V3WebSearchResultStatus {
    Completed,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3WebSearchSource {
    pub ref_id: String,
    pub url: Option<String>,
    pub title: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3WebSearchError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

/// Typed return to the same Hub node. No implicit side effect or client frame
/// write is permitted through this contract.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum V3WebSearchHookOutcome {
    NotApplicable,
    Completed(V3WebSearchResult),
    Failed(V3WebSearchError),
}

impl V3WebSearchResult {
    pub fn validate(&self) -> Result<(), V3WebSearchHookContractError> {
        if self.call_id.trim().is_empty() {
            return Err(V3WebSearchHookContractError::MissingCallId);
        }
        match self.status {
            V3WebSearchResultStatus::Completed => {
                if self.error.is_some() {
                    return Err(V3WebSearchHookContractError::CompletedResultHasError);
                }
                if self.content.as_deref().is_none_or(str::is_empty) && self.sources.is_empty() {
                    return Err(V3WebSearchHookContractError::CompletedResultEmpty);
                }
            }
            V3WebSearchResultStatus::Failed => {
                if self.error.is_none() {
                    return Err(V3WebSearchHookContractError::FailedResultMissingError);
                }
                if self.content.is_some() || !self.sources.is_empty() {
                    return Err(V3WebSearchHookContractError::FailedResultHasContent);
                }
            }
        }
        if self
            .sources
            .iter()
            .any(|source| source.ref_id.trim().is_empty())
        {
            return Err(V3WebSearchHookContractError::MissingSourceRef);
        }
        if self
            .metadata
            .as_ref()
            .is_some_and(web_search_metadata_contains_control_state)
        {
            return Err(V3WebSearchHookContractError::ControlStateInMetadata);
        }
        Ok(())
    }
}

fn web_search_metadata_contains_control_state(value: &Value) -> bool {
    match value {
        Value::Object(object) => object.iter().any(|(key, value)| {
            matches!(key.as_str(), "phase" | "scope_key" | "call_id")
                || web_search_metadata_contains_control_state(value)
        }),
        Value::Array(items) => items.iter().any(web_search_metadata_contains_control_state),
        _ => false,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum V3WebSearchHookContractError {
    #[error("web_search hook request requires a non-empty call_id")]
    MissingCallId,
    #[error("completed web_search result must not carry an error")]
    CompletedResultHasError,
    #[error("completed web_search result requires content or sources")]
    CompletedResultEmpty,
    #[error("failed web_search result requires a typed error")]
    FailedResultMissingError,
    #[error("failed web_search result must not carry content or sources")]
    FailedResultHasContent,
    #[error("web_search result source requires a non-empty ref_id")]
    MissingSourceRef,
    #[error("web_search result metadata must not carry control state")]
    ControlStateInMetadata,
}

pub(crate) fn web_search_hook_outcome_from_center_state(
    state: &V3WebSearchCenterState,
) -> Result<V3WebSearchHookOutcome, V3WebSearchHookContractError> {
    match state.phase() {
        V3WebSearchCenterPhase::SearchResultCaptured
        | V3WebSearchCenterPhase::HostedResultProjected
        | V3WebSearchCenterPhase::MainModelContinuationPrepared
        | V3WebSearchCenterPhase::Completed => {
            let call_id = state
                .original_call_id()
                .filter(|value| !value.trim().is_empty())
                .ok_or(V3WebSearchHookContractError::MissingCallId)?;
            let content = state
                .normalized_result()
                .and_then(|value| value.get("text_result"))
                .and_then(Value::as_str)
                .map(str::to_string);
            let metadata = state
                .normalized_result()
                .and_then(|value| value.get("usage"))
                .cloned();
            let result = V3WebSearchResult {
                call_id: call_id.to_string(),
                status: V3WebSearchResultStatus::Completed,
                content,
                sources: Vec::new(),
                metadata,
                error: None,
            };
            result.validate()?;
            Ok(V3WebSearchHookOutcome::Completed(result))
        }
        V3WebSearchCenterPhase::Failed => {
            let message = state
                .typed_failure()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or("web_search ServerTool state is terminal failed")
                .to_string();
            Ok(V3WebSearchHookOutcome::Failed(V3WebSearchError {
                code: "web_search_failed".to_string(),
                message,
                retryable: false,
            }))
        }
        _ => Ok(V3WebSearchHookOutcome::NotApplicable),
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct V3ToolThinkingTurnContext {
    enabled: bool,
    original_custom_tool_names: BTreeSet<String>,
}

impl V3ToolThinkingTurnContext {
    pub(crate) fn disabled() -> Self {
        Self::default()
    }

    pub(crate) fn enabled(original_custom_tool_names: BTreeSet<String>) -> Self {
        Self {
            enabled: true,
            original_custom_tool_names,
        }
    }

    pub(crate) fn enabled_flag(&self) -> bool {
        self.enabled
    }

    pub(crate) fn is_original_custom_tool(&self, name: &str) -> bool {
        self.original_custom_tool_names.contains(name)
    }

    pub(crate) fn original_custom_tool_names(&self) -> Option<&BTreeSet<String>> {
        self.enabled.then_some(&self.original_custom_tool_names)
    }
}

pub(crate) fn inject_v3_tool_thinking_guidance_at_req04(
    payload: &mut Value,
    current_payload_start: usize,
    enabled: bool,
) -> Result<(), V3HubRelayRequestError> {
    let _ =
        compile_v3_tool_thinking_turn_context_at_req04(payload, current_payload_start, enabled)?;
    Ok(())
}

pub(crate) fn compile_v3_tool_thinking_turn_context_at_req04(
    payload: &mut Value,
    current_payload_start: usize,
    enabled: bool,
) -> Result<V3ToolThinkingTurnContext, V3HubRelayRequestError> {
    if !enabled || payload.get("contents").is_some() || payload.get("system_instruction").is_some()
    {
        return Ok(V3ToolThinkingTurnContext::disabled());
    }
    inject_v3_tool_thinking_fields_into_tool_schemas(payload)
        .map_err(|reason| V3HubRelayRequestError::ToolThinkingSchemaInvalid { reason })?;
    let original_custom_tool_names = wrap_v3_custom_tools_at_req04(payload)?;
    if let Some(messages) = payload.get("messages").and_then(Value::as_array) {
        if current_payload_start > messages.len() {
            return Err(V3HubRelayRequestError::CurrentPayloadBoundaryInvalid {
                start: current_payload_start,
                len: messages.len(),
            });
        }
    }
    Ok(V3ToolThinkingTurnContext::enabled(
        original_custom_tool_names,
    ))
}

fn wrap_v3_custom_tools_at_req04(
    payload: &mut Value,
) -> Result<BTreeSet<String>, V3HubRelayRequestError> {
    let Some(tools) = payload.get_mut("tools").and_then(Value::as_array_mut) else {
        return Ok(BTreeSet::new());
    };
    let mut names = BTreeSet::new();
    for (index, tool) in tools.iter_mut().enumerate() {
        let Some(row) = tool.as_object() else {
            continue;
        };
        if row.get("type").and_then(Value::as_str) != Some("custom") {
            continue;
        }
        let name = row
            .get("name")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| V3HubRelayRequestError::ToolThinkingSchemaInvalid {
                reason: format!("custom tool at $.tools[{index}] has no non-empty name"),
            })?
            .to_string();
        if name.eq_ignore_ascii_case("apply_patch") {
            continue;
        }
        let mut function = serde_json::Map::new();
        function.insert("name".to_string(), Value::String(name.clone()));
        if let Some(description) = row.get("description") {
            function.insert("description".to_string(), description.clone());
        }
        function.insert(
            "parameters".to_string(),
            json!({
                "type":"object",
                "properties":{
                    "input":{"type":"string"},
                    "reason":{"type":"string","minLength":1,"maxLength":50},
                    "goal_alignment_confidence":{"type":"integer","minimum":0,"maximum":100}
                },
                "required":["input","reason","goal_alignment_confidence"],
                "additionalProperties":false
            }),
        );
        *tool = json!({"type":"function","function":function});
        names.insert(name);
    }
    Ok(names)
}

pub(crate) fn current_v3_tool_thinking_payload_start(payload: &Value) -> Result<usize, String> {
    for field in ["messages", "input"] {
        let Some(items) = payload.get(field).and_then(Value::as_array) else {
            continue;
        };
        return items
            .iter()
            .rposition(|item| item.get("role").and_then(Value::as_str) == Some("user"))
            .ok_or_else(|| format!("Responses {field} array has no current user message"));
    }
    Ok(0)
}

pub(crate) fn is_v3_tool_thinking_output_continuation(payload: &Value) -> bool {
    payload
        .get("input")
        .and_then(Value::as_array)
        .is_some_and(|items| {
            !items.is_empty()
                && items.iter().all(|item| {
                    matches!(
                        item.get("type").and_then(Value::as_str),
                        Some(
                            "function_call_output" | "custom_tool_call_output" | "tool_call_output"
                        )
                    )
                })
        })
}

fn inject_v3_tool_thinking_fields_into_tool_schemas(payload: &mut Value) -> Result<(), String> {
    let Some(tools) = payload.get_mut("tools").and_then(Value::as_array_mut) else {
        return Ok(());
    };
    for tool in tools {
        inject_v3_tool_thinking_fields_into_tool(tool)?;
    }
    Ok(())
}

fn inject_v3_tool_thinking_fields_into_tool(tool: &mut Value) -> Result<(), String> {
    for field in ["input_schema", "parameters"] {
        if let Some(schema) = tool.get_mut(field) {
            inject_v3_tool_thinking_fields_into_schema(schema)?;
        }
    }
    if let Some(schema) = tool
        .get_mut("function")
        .and_then(Value::as_object_mut)
        .and_then(|function| function.get_mut("parameters"))
    {
        inject_v3_tool_thinking_fields_into_schema(schema)?;
    }
    Ok(())
}

pub(super) fn inject_v3_tool_thinking_fields_into_schema(schema: &mut Value) -> Result<(), String> {
    let Some(schema) = schema.as_object_mut() else {
        return Err("tool-thinking schema must be an object".to_string());
    };
    if let Some(properties) = schema.get("properties") {
        let properties = properties
            .as_object()
            .ok_or_else(|| "tool-thinking schema properties must be an object".to_string())?;
        if properties.contains_key("reason") || properties.contains_key("goal_alignment_confidence")
        {
            return Ok(());
        }
    }
    if let Some(required) = schema.get("required") {
        if !required.is_array() {
            return Err("tool-thinking schema required must be an array".to_string());
        }
    }
    if !schema.contains_key("properties") {
        schema.insert("properties".to_string(), json!({}));
    }
    if !schema.contains_key("required") {
        schema.insert("required".to_string(), json!([]));
    }
    let properties = schema
        .get_mut("properties")
        .and_then(Value::as_object_mut)
        .expect("validated properties");
    properties.insert(
        "reason".to_string(),
        json!({"type":"string","minLength":1,"maxLength":50}),
    );
    properties.insert(
        "goal_alignment_confidence".to_string(),
        json!({"type":"integer","minimum":0,"maximum":100}),
    );
    let required = schema
        .get_mut("required")
        .and_then(Value::as_array_mut)
        .expect("validated required");
    for field in ["reason", "goal_alignment_confidence"] {
        if !required.iter().any(|value| value.as_str() == Some(field)) {
            required.push(Value::String(field.to_string()));
        }
    }
    Ok(())
}

pub(crate) fn identify_v3_servertool_request_tool(
    _payload: &Value,
    web_search_mode_b: bool,
) -> Option<V3ServerToolName> {
    web_search_mode_b.then_some(V3ServerToolName::WebSearch)
}

pub(crate) fn inspect_v3_servertool_response_tool(payload: &Value) -> Option<V3ServerToolName> {
    payload
        .get("output")
        .and_then(Value::as_array)
        .and_then(|output| {
            output.iter().find_map(|item| {
                let kind = item.get("type").and_then(Value::as_str).unwrap_or_default();
                if !matches!(kind, "function_call" | "tool_call" | "custom_tool_call") {
                    return None;
                }
                let name = item
                    .get("name")
                    .and_then(Value::as_str)
                    .or_else(|| item.pointer("/function/name").and_then(Value::as_str))?;
                matches!(name.trim(), "web_search" | "web_search_preview")
                    .then_some(V3ServerToolName::WebSearch)
            })
        })
}

pub(crate) fn govern_v3_servertool_request_at_req04(
    payload: &mut Value,
    current_payload_start: usize,
    _events: &mut Vec<V3HubRelayRequestHookEvent>,
    web_search_mode_b: bool,
    tool_thinking_enabled: bool,
) -> Result<(Option<V3WebSearchCenterState>, V3ToolThinkingTurnContext), V3HubRelayRequestError> {
    let web_search_state = if web_search_mode_b && payload_declares_web_search_tool(payload) {
        apply_v3_web_search_request_hook_at_req04(payload)?
    } else {
        None
    };
    let tool_thinking_context = compile_v3_tool_thinking_turn_context_at_req04(
        payload,
        current_payload_start,
        tool_thinking_enabled,
    )?;
    Ok((web_search_state, tool_thinking_context))
}

pub fn apply_v3_web_search_request_hook_at_req04(
    payload: &mut Value,
) -> Result<Option<V3WebSearchCenterState>, V3HubRelayRequestError> {
    if !payload_declares_web_search_tool(payload) {
        return Ok(None);
    }
    V3WebSearchCenterState::new()
        .transition_to(
            V3WebSearchCenterPhase::LocalToolSurfaceActive,
            "req04_web_search_surface_active",
        )
        .map(Some)
        .map_err(|reason| V3HubRelayRequestError::WebSearchToolSurfaceActivationFailed { reason })
}

fn payload_declares_web_search_tool(payload: &Value) -> bool {
    payload
        .get("tools")
        .and_then(Value::as_array)
        .is_some_and(|tools| {
            tools.iter().any(|tool| {
                if matches!(
                    tool.get("type").and_then(Value::as_str),
                    Some("web_search" | "web_search_preview")
                ) {
                    return true;
                }
                tool.get("name")
                    .and_then(Value::as_str)
                    .or_else(|| tool.pointer("/function/name").and_then(Value::as_str))
                    .is_some_and(|name| {
                        matches!(
                            name.trim().to_ascii_lowercase().as_str(),
                            "websearch" | "web_search"
                        )
                    })
            })
        })
}

pub struct V3ServerToolResponseHookOutcome {
    pub input: V3HubRespInbound02Normalized,
    pub web_search_state: Option<V3WebSearchCenterState>,
    pub web_search_hook_outcome: V3WebSearchHookOutcome,
    pub intercepted: bool,
}

pub fn apply_v3_tool_call_servertool_hook_at_resp03(
    mut input: V3HubRespInbound02Normalized,
    profile: &V3HubRelayResponseHookProfile,
) -> Result<V3ServerToolResponseHookOutcome, V3HubRelayResponseError> {
    if project_registered_servertool_calls_to_client_exec(&mut input, profile)? {
        return Ok(V3ServerToolResponseHookOutcome {
            input,
            web_search_state: None,
            web_search_hook_outcome: V3WebSearchHookOutcome::NotApplicable,
            intercepted: false,
        });
    }
    if profile.web_search_local_surface_active()
        && first_local_websearch_tool_call(input.provider_payload().as_ref())?.is_some()
    {
        return intercept_local_web_search_call(input, profile)?
            .ok_or(V3HubRelayResponseError::MissingWebSearchActivation);
    }
    Ok(V3ServerToolResponseHookOutcome {
        input,
        web_search_state: None,
        web_search_hook_outcome: V3WebSearchHookOutcome::NotApplicable,
        intercepted: false,
    })
}

fn project_registered_servertool_calls_to_client_exec(
    input: &mut V3HubRespInbound02Normalized,
    profile: &V3HubRelayResponseHookProfile,
) -> Result<bool, V3HubRelayResponseError> {
    let mut payload = input.provider_payload().as_ref().clone();
    let Some(output) = payload.get_mut("output").and_then(Value::as_array_mut) else {
        return Ok(false);
    };
    let mut changed = false;
    for (index, item) in output.iter_mut().enumerate() {
        let Some(object) = item.as_object_mut() else {
            continue;
        };
        if !matches!(
            object.get("type").and_then(Value::as_str),
            Some("function_call" | "tool_call" | "custom_tool_call")
        ) {
            continue;
        }
        let Some(name) = object
            .get("name")
            .and_then(Value::as_str)
            .or_else(|| {
                object
                    .get("function")
                    .and_then(Value::as_object)
                    .and_then(|function| function.get("name"))
                    .and_then(Value::as_str)
            })
            .map(str::to_string)
        else {
            continue;
        };
        if !profile.is_servertool_name(&name) || !is_client_exec_cli_projection(&name) {
            continue;
        }
        let arguments = object
            .get("arguments")
            .or_else(|| {
                object
                    .get("function")
                    .and_then(Value::as_object)
                    .and_then(|function| function.get("arguments"))
            })
            .and_then(Value::as_str)
            .ok_or(V3HubRelayResponseError::MalformedToolCall {
                index,
                reason: "registered servertool call missing arguments",
            })?;
        let parsed = parse_servertool_cli_projection_tool_arguments(
            ServertoolCliProjectionToolArgumentsInput {
                arguments: arguments.to_string(),
            },
        )
        .map_err(|_| V3HubRelayResponseError::MalformedToolCall {
            index,
            reason: "registered servertool call arguments must be a JSON object",
        })?;
        let projection =
            build_client_exec_cli_projection_output(&name, &format!("{name}_flow"), parsed)
                .map_err(|_| V3HubRelayResponseError::MalformedToolCall {
                    index,
                    reason: "registered servertool CLI projection failed",
                })?;
        let command = projection
            .get("execCommand")
            .and_then(Value::as_str)
            .ok_or(V3HubRelayResponseError::MalformedToolCall {
                index,
                reason: "registered servertool CLI projection missing execCommand",
            })?;
        object.insert(
            "type".to_string(),
            Value::String("function_call".to_string()),
        );
        object.insert(
            "name".to_string(),
            Value::String("exec_command".to_string()),
        );
        object.insert(
            "arguments".to_string(),
            Value::String(
                serde_json::to_string(&json!({"cmd": command})).map_err(|_| {
                    V3HubRelayResponseError::MalformedToolCall {
                        index,
                        reason: "registered servertool exec_command arguments failed",
                    }
                })?,
            ),
        );
        object.remove("function");
        changed = true;
    }
    if changed {
        *input.provider_payload_mut() = Arc::new(payload);
    }
    Ok(changed)
}

fn strip_local_websearch_tool_call(payload: &Value, call_id: &str) -> Value {
    let mut projected = payload.clone();
    if let Some(output) = projected.get_mut("output").and_then(Value::as_array_mut) {
        output.retain(|item| {
            let item_call_id = item
                .get("call_id")
                .or_else(|| item.get("id"))
                .and_then(Value::as_str);
            let is_call = item_call_id == Some(call_id)
                && matches!(
                    item.get("type").and_then(Value::as_str),
                    Some("function_call" | "tool_call" | "custom_tool_call")
                );
            let is_result = item.get("type").and_then(Value::as_str)
                == Some("web_search_tool_result")
                && item.get("tool_use_id").and_then(Value::as_str) == Some(call_id);
            !(is_call || is_result)
        });
    }
    projected
}

fn intercept_local_web_search_call(
    mut input: V3HubRespInbound02Normalized,
    profile: &V3HubRelayResponseHookProfile,
) -> Result<Option<V3ServerToolResponseHookOutcome>, V3HubRelayResponseError> {
    let Some(call) = first_local_websearch_tool_call(input.provider_payload().as_ref())? else {
        return Ok(None);
    };
    let hosted_text =
        hosted_web_search_result_text(input.provider_payload().as_ref(), &call.call_id);
    *input.provider_payload_mut() = Arc::new(strip_local_websearch_tool_call(
        input.provider_payload().as_ref(),
        &call.call_id,
    ));
    let center_state = profile
        .web_search_center_state()
        .ok_or(V3HubRelayResponseError::MissingWebSearchActivation)?
        .clone();
    let observed = center_state
        .transition_to(
            V3WebSearchCenterPhase::ToolCallObserved,
            "resp03_websearch_call_observed",
        )
        .map_err(|reason| V3HubRelayResponseError::WebSearchStateTransitionFailed { reason })?
        .with_original_call_id(Some(call.call_id.clone()))
        .with_query(Some(call.query.clone()))
        .with_count(call.count)
        .with_recency(call.recency)
        .with_content_types(call.content_types);
    let state = match hosted_text {
        Some(text_result) => observed
            .transition_to(
                V3WebSearchCenterPhase::SearchDispatchPrepared,
                "resp03_hosted_result_observed",
            )
            .and_then(|state| {
                state.transition_to(
                    V3WebSearchCenterPhase::SearchInFlight,
                    "resp03_hosted_result_observed",
                )
            })
            .and_then(|state| {
                state.transition_to(
                    V3WebSearchCenterPhase::SearchResultCaptured,
                    "resp03_hosted_result_observed",
                )
            })
            .map(|state| {
                state.with_normalized_result(Some(
                    json!({"query":call.query,"text_result":text_result}),
                ))
            })
            .map_err(|reason| V3HubRelayResponseError::WebSearchStateTransitionFailed { reason })?,
        None => observed,
    };
    let web_search_hook_outcome =
        web_search_hook_outcome_from_center_state(&state).map_err(|error| {
            V3HubRelayResponseError::WebSearchHookContractFailed {
                reason: error.to_string(),
            }
        })?;
    Ok(Some(V3ServerToolResponseHookOutcome {
        input,
        web_search_state: Some(state),
        web_search_hook_outcome,
        intercepted: true,
    }))
}

#[cfg(test)]
mod web_search_hook_contract_tests {
    use super::*;

    #[test]
    fn web_search_hook_result_accepts_typed_sources_without_control_state() {
        let result = V3WebSearchResult {
            call_id: "call_web_search_1".to_string(),
            status: V3WebSearchResultStatus::Completed,
            content: Some("typed search result".to_string()),
            sources: vec![V3WebSearchSource {
                ref_id: "source-1".to_string(),
                url: Some("https://example.com".to_string()),
                title: Some("Example".to_string()),
            }],
            metadata: Some(json!({"usage":{"search_queries":1}})),
            error: None,
        };
        result.validate().unwrap();
    }

    #[test]
    fn web_search_hook_result_rejects_control_state_in_metadata() {
        let result = V3WebSearchResult {
            call_id: "call_web_search_1".to_string(),
            status: V3WebSearchResultStatus::Completed,
            content: Some("typed search result".to_string()),
            sources: Vec::new(),
            metadata: Some(json!({
                "phase":"SearchResultCaptured",
                "scope_key":"session-a|conversation-a"
            })),
            error: None,
        };
        assert_eq!(
            result.validate(),
            Err(V3WebSearchHookContractError::ControlStateInMetadata)
        );
    }

    #[test]
    fn web_search_hook_result_rejects_nested_control_state_in_metadata() {
        let result = V3WebSearchResult {
            call_id: "call_web_search_1".to_string(),
            status: V3WebSearchResultStatus::Completed,
            content: Some("typed search result".to_string()),
            sources: Vec::new(),
            metadata: Some(json!({
                "usage": {
                    "nested": [{"scope_key":"session-a|conversation-a"}]
                }
            })),
            error: None,
        };
        assert_eq!(
            result.validate(),
            Err(V3WebSearchHookContractError::ControlStateInMetadata)
        );
    }

    #[test]
    fn web_search_hook_result_rejects_failed_result_with_content() {
        let result = V3WebSearchResult {
            call_id: "call_web_search_1".to_string(),
            status: V3WebSearchResultStatus::Failed,
            content: Some("must not be treated as success".to_string()),
            sources: Vec::new(),
            metadata: None,
            error: Some(V3WebSearchError {
                code: "timeout".to_string(),
                message: "deadline exceeded".to_string(),
                retryable: true,
            }),
        };
        assert_eq!(
            result.validate(),
            Err(V3WebSearchHookContractError::FailedResultHasContent)
        );
    }

    #[test]
    fn web_search_hook_result_rejects_completed_result_with_error() {
        let result = V3WebSearchResult {
            call_id: "call_web_search_1".to_string(),
            status: V3WebSearchResultStatus::Completed,
            content: Some("typed search result".to_string()),
            sources: Vec::new(),
            metadata: None,
            error: Some(V3WebSearchError {
                code: "late_error".to_string(),
                message: "must not be success-wrapped".to_string(),
                retryable: false,
            }),
        };
        assert_eq!(
            result.validate(),
            Err(V3WebSearchHookContractError::CompletedResultHasError)
        );
    }

    #[test]
    fn web_search_hook_result_rejects_missing_source_ref() {
        let result = V3WebSearchResult {
            call_id: "call_web_search_1".to_string(),
            status: V3WebSearchResultStatus::Completed,
            content: None,
            sources: vec![V3WebSearchSource {
                ref_id: " ".to_string(),
                url: None,
                title: None,
            }],
            metadata: None,
            error: None,
        };
        assert_eq!(
            result.validate(),
            Err(V3WebSearchHookContractError::MissingSourceRef)
        );
    }

    #[test]
    fn web_search_hook_outcome_requires_call_id_for_completed_state() {
        let state = V3WebSearchCenterState::new()
            .transition_to(
                V3WebSearchCenterPhase::LocalToolSurfaceActive,
                "test_active",
            )
            .unwrap()
            .transition_to(V3WebSearchCenterPhase::ToolCallObserved, "test_observed")
            .unwrap()
            .transition_to(
                V3WebSearchCenterPhase::SearchDispatchPrepared,
                "test_prepared",
            )
            .unwrap()
            .transition_to(V3WebSearchCenterPhase::SearchInFlight, "test_in_flight")
            .unwrap()
            .transition_to(
                V3WebSearchCenterPhase::SearchResultCaptured,
                "test_captured_without_call_id",
            )
            .unwrap()
            .with_normalized_result(Some(json!({"text_result":"result without identity"})));
        assert_eq!(
            web_search_hook_outcome_from_center_state(&state),
            Err(V3WebSearchHookContractError::MissingCallId)
        );
    }

    #[test]
    fn web_search_hook_outcome_uses_typed_failure_message() {
        let state = V3WebSearchCenterState::new()
            .transition_to(V3WebSearchCenterPhase::Failed, "test_failed")
            .unwrap()
            .with_typed_failure(Some("backend timeout"));
        assert_eq!(
            web_search_hook_outcome_from_center_state(&state).unwrap(),
            V3WebSearchHookOutcome::Failed(V3WebSearchError {
                code: "web_search_failed".to_string(),
                message: "backend timeout".to_string(),
                retryable: false,
            })
        );
    }

    #[test]
    fn web_search_hook_outcome_maps_only_explicit_usage_metadata() {
        let state = V3WebSearchCenterState::new()
            .transition_to(
                V3WebSearchCenterPhase::LocalToolSurfaceActive,
                "test_active",
            )
            .unwrap()
            .transition_to(V3WebSearchCenterPhase::ToolCallObserved, "test_observed")
            .unwrap()
            .transition_to(
                V3WebSearchCenterPhase::SearchDispatchPrepared,
                "test_prepared",
            )
            .unwrap()
            .transition_to(V3WebSearchCenterPhase::SearchInFlight, "test_in_flight")
            .unwrap()
            .transition_to(
                V3WebSearchCenterPhase::SearchResultCaptured,
                "test_captured",
            )
            .unwrap()
            .with_original_call_id(Some("call_web_search_1".to_string()))
            .with_normalized_result(Some(json!({
                "query":"typed query",
                "text_result":"typed search result",
                "usage":{"search_queries":1}
            })));
        let V3WebSearchHookOutcome::Completed(result) =
            web_search_hook_outcome_from_center_state(&state).unwrap()
        else {
            panic!("completed state must produce a completed outcome");
        };
        assert_eq!(result.content.as_deref(), Some("typed search result"));
        assert_eq!(result.metadata, Some(json!({"search_queries":1})));
    }
}
