use serde_json::Value;

fn has_declared_apply_patch_tool(payload: &Value) -> bool {
    let Some(root) = payload.as_object() else {
        return false;
    };
    let Some(tools) = root.get("tools").and_then(Value::as_array) else {
        return false;
    };
    for tool in tools {
        let Some(tool_row) = tool.as_object() else {
            continue;
        };
        let tool_type = tool_row
            .get("type")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .unwrap_or("");
        let direct_name = tool_row
            .get("name")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .unwrap_or("");
        if direct_name == "apply_patch" {
            return true;
        }
        if tool_type == "custom" && direct_name == "apply_patch" {
            return true;
        }
    }
    false
}

fn find_responses_function_call_output_content_violation(payload: &Value) -> Option<String> {
    let root = payload.as_object()?;
    let input = root.get("input")?.as_array()?;
    for (index, item) in input.iter().enumerate() {
        let Some(row) = item.as_object() else {
            continue;
        };
        if row.get("type").and_then(Value::as_str) != Some("function_call_output") {
            continue;
        }
        if row.contains_key("content") {
            return Some(format!(
                "openai-responses provider wire input[{}] function_call_output must not include content; use output only",
                index
            ));
        }
    }
    None
}

fn evaluate_responses_direct_route_decision(
    payload: &Value,
    metadata: &Value,
    inbound_protocol: &str,
    apply_patch_mode: &str,
) -> Result<Value, String> {
    let _ = apply_patch_mode;
    let has_declared_apply_patch_tool = has_declared_apply_patch_tool(payload);
    if inbound_protocol == "openai-responses"
        && requires_hub_relay_for_servertool_followup(payload, metadata)
    {
        return Ok(serde_json::json!({
            "providerWireValid": true,
            "requiresHubRelay": true,
            "reason": "servertool_followup_requires_hub_relay",
            "hasDeclaredApplyPatchTool": has_declared_apply_patch_tool
        }));
    }
    if inbound_protocol == "openai-responses" {
        if let Some(reason) = find_responses_function_call_output_content_violation(payload) {
            return Ok(serde_json::json!({
                "providerWireValid": false,
                "requiresHubRelay": false,
                "reason": reason,
                "hasDeclaredApplyPatchTool": has_declared_apply_patch_tool
            }));
        }
    }
    Ok(serde_json::json!({
        "providerWireValid": true,
        "requiresHubRelay": false,
        "reason": null,
        "hasDeclaredApplyPatchTool": has_declared_apply_patch_tool
    }))
}

fn requires_hub_relay_for_servertool_followup(payload: &Value, metadata: &Value) -> bool {
    if stop_message_include_direct(metadata) {
        return true;
    }
    if has_stop_message_cli_result(payload) {
        return true;
    }
    if has_stop_message_cli_result(metadata) {
        return true;
    }
    has_servertool_followup_marker(metadata)
}

fn has_stop_message_cli_result(value: &Value) -> bool {
    let mut seen = 0usize;
    scan_stop_message_cli_result(value, 0, &mut seen)
}

fn scan_stop_message_cli_result(value: &Value, depth: usize, seen: &mut usize) -> bool {
    if depth > 10 {
        return false;
    }
    *seen += 1;
    if *seen > 2000 {
        return false;
    }
    if is_stop_message_cli_result_object(value) {
        return true;
    }
    if let Some(items) = value.as_array() {
        return items
            .iter()
            .any(|item| scan_stop_message_cli_result(item, depth + 1, seen));
    }
    let Some(record) = value.as_object() else {
        return false;
    };
    record
        .values()
        .any(|item| scan_stop_message_cli_result(item, depth + 1, seen))
}

fn is_stop_message_cli_result_object(value: &Value) -> bool {
    let Some(record) = value.as_object() else {
        return false;
    };
    let type_value = record
        .get("type")
        .and_then(Value::as_str)
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_default();
    let role = record
        .get("role")
        .and_then(Value::as_str)
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_default();
    let tool_result_like = type_value == "function_call_output"
        || type_value == "tool_result"
        || type_value == "tool_message"
        || role == "tool"
        || record.contains_key("call_id")
        || record.contains_key("tool_call_id");
    if !tool_result_like {
        return false;
    }
    let mut parts = Vec::<String>::new();
    for key in ["output", "content", "text", "arguments"] {
        collect_direct_stop_message_text(record.get(key), &mut parts);
    }
    parts.iter().any(|text| {
        text.contains("routecodex servertool run stop_message_auto")
            || (text.contains("\"toolName\"")
                && text.contains("\"stop_message_auto\"")
                && text.contains("\"flowId\"")
                && text.contains("\"stop_message_flow\""))
    })
}

fn collect_direct_stop_message_text(value: Option<&Value>, out: &mut Vec<String>) {
    match value {
        Some(Value::String(text)) => out.push(text.clone()),
        Some(Value::Array(items)) => {
            for item in items {
                collect_direct_stop_message_text(Some(item), out);
            }
        }
        Some(Value::Object(record)) => {
            collect_direct_stop_message_text(record.get("text"), out);
            collect_direct_stop_message_text(record.get("output_text"), out);
            collect_direct_stop_message_text(record.get("content"), out);
        }
        _ => {}
    }
}

fn read_boolish(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Bool(true)))
        || value
            .and_then(Value::as_str)
            .map(|text| text.trim().eq_ignore_ascii_case("true"))
            .unwrap_or(false)
}

fn stop_message_excludes_direct(metadata: &Value) -> bool {
    let Some(root) = metadata.as_object() else {
        return false;
    };
    let rt = root.get("__rt").and_then(Value::as_object);
    let stop_message_enabled = root
        .get("stopMessageEnabled")
        .map(|value| read_boolish(Some(value)))
        .or_else(|| {
            rt.and_then(|record| {
                record
                    .get("stopMessageEnabled")
                    .map(|value| read_boolish(Some(value)))
            })
        })
        .unwrap_or(false);
    if !stop_message_enabled {
        return false;
    }
    root.get("stopMessageExcludeDirect")
        .map(|value| read_boolish(Some(value)))
        .or_else(|| {
            rt.and_then(|record| {
                record
                    .get("stopMessageExcludeDirect")
                    .map(|value| read_boolish(Some(value)))
            })
        })
        .unwrap_or(false)
}

fn stop_message_include_direct(metadata: &Value) -> bool {
    let Some(root) = metadata.as_object() else {
        return false;
    };
    let rt = root.get("__rt").and_then(Value::as_object);
    let stop_message_enabled = root
        .get("stopMessageEnabled")
        .map(|value| read_boolish(Some(value)))
        .or_else(|| {
            rt.and_then(|record| {
                record
                    .get("stopMessageEnabled")
                    .map(|value| read_boolish(Some(value)))
            })
        })
        .unwrap_or(false);
    if !stop_message_enabled {
        return false;
    }
    !root
        .get("stopMessageExcludeDirect")
        .map(|value| read_boolish(Some(value)))
        .or_else(|| {
            rt.and_then(|record| {
                record
                    .get("stopMessageExcludeDirect")
                    .map(|value| read_boolish(Some(value)))
            })
        })
        .unwrap_or(false)
}

fn has_servertool_followup_marker(metadata: &Value) -> bool {
    let Some(root) = metadata.as_object() else {
        return false;
    };
    let rt = root.get("__rt").and_then(Value::as_object);
    if read_boolish(root.get("serverToolFollowup"))
        || rt
            .map(|record| read_boolish(record.get("serverToolFollowup")))
            .unwrap_or(false)
    {
        return true;
    }
    let followup_source = read_trimmed_lower(root.get("followupSource"))
        .or_else(|| read_trimmed_lower(root.get("serverToolFollowupSource")))
        .or_else(|| read_trimmed_lower(root.get("clientInjectSource")))
        .or_else(|| rt.and_then(|record| read_trimmed_lower(record.get("followupSource"))))
        .or_else(|| rt.and_then(|record| read_trimmed_lower(record.get("clientInjectSource"))))
        .or_else(|| {
            rt.and_then(|record| read_trimmed_lower(record.get("serverToolFollowupSource")))
        });
    if followup_source.is_some() {
        return true;
    }
    let stopless_goal_status = read_trimmed_lower(root.get("stoplessGoalStatus"))
        .or_else(|| rt.and_then(|record| read_trimmed_lower(record.get("stoplessGoalStatus"))))
        .or_else(|| {
            root.get("stoplessGoalState")
                .and_then(Value::as_object)
                .and_then(|record| read_trimmed_lower(record.get("status")))
        })
        .or_else(|| {
            rt.and_then(|record| record.get("stoplessGoalState"))
                .and_then(Value::as_object)
                .and_then(|record| read_trimmed_lower(record.get("status")))
        });
    stopless_goal_status.as_deref() == Some("active")
}

fn read_trimmed_lower(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?.trim().to_ascii_lowercase();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

#[cfg(test)]
mod responses_direct_route_decision_tests {
    use super::*;

    #[test]
    fn direct_decision_does_not_relay_responses_reasoning_content() {
        let decision = evaluate_responses_direct_route_decision(
            &serde_json::json!({
                "model": "gpt-5.5",
                "input": [
                    {
                        "type": "reasoning",
                        "content": [
                            { "type": "reasoning_text", "text": "client-standard history" }
                        ],
                        "summary": [
                            { "type": "summary_text", "text": "summary stays" }
                        ]
                    }
                ]
            }),
            &Value::Null,
            "openai-responses",
            "client",
        )
        .expect("same-protocol direct must not use payload shape to force relay");

        assert_eq!(decision["providerWireValid"], true);
        assert_eq!(decision["requiresHubRelay"], false);
        assert_eq!(decision["reason"], Value::Null);
    }

    #[test]
    fn valid_responses_wire_allows_direct_decision() {
        let decision = evaluate_responses_direct_route_decision(
            &serde_json::json!({
                "model": "gpt-5.5",
                "input": [
                    {
                        "role": "user",
                        "content": [
                            { "type": "input_text", "text": "hello" }
                        ]
                    }
                ]
            }),
            &Value::Null,
            "openai-responses",
            "client",
        )
        .expect("valid direct decision should succeed");

        assert_eq!(decision["providerWireValid"], true);
        assert_eq!(decision["requiresHubRelay"], false);
    }

    #[test]
    fn responses_client_tools_stay_direct_on_same_protocol_path() {
        let decision = evaluate_responses_direct_route_decision(
            &serde_json::json!({
                "model": "gpt-5.5",
                "input": [
                    {
                        "role": "user",
                        "content": [
                            { "type": "input_text", "text": "hello" }
                        ]
                    }
                ],
                "tools": [
                    { "type": "function", "name": "exec_command", "parameters": { "type": "object" } }
                ]
            }),
            &Value::Null,
            "openai-responses",
            "client",
        )
        .expect("same-protocol client tool declarations should stay direct");

        assert_eq!(decision["providerWireValid"], true);
        assert_eq!(decision["requiresHubRelay"], false);
        assert_eq!(decision["reason"], Value::Null);
    }

    #[test]
    fn responses_client_tools_stay_direct_when_stop_message_excludes_direct() {
        let decision = evaluate_responses_direct_route_decision(
            &serde_json::json!({
                "model": "gpt-5.5",
                "input": [
                    {
                        "role": "user",
                        "content": [
                            { "type": "input_text", "text": "hello" }
                        ]
                    }
                ],
                "tools": [
                    { "type": "function", "name": "exec_command", "parameters": { "type": "object" } }
                ]
            }),
            &serde_json::json!({
                "stopMessageEnabled": true,
                "stopMessageExcludeDirect": true
            }),
            "openai-responses",
            "client",
        )
        .expect("same-protocol client tools must stay direct when stopless is only configured");

        assert_eq!(decision["providerWireValid"], true);
        assert_eq!(decision["requiresHubRelay"], false);
        assert_eq!(decision["reason"], Value::Null);
    }

    #[test]
    fn responses_request_relays_when_stop_message_includes_direct() {
        let decision = evaluate_responses_direct_route_decision(
            &serde_json::json!({
                "model": "gpt-5.5",
                "input": [
                    {
                        "role": "user",
                        "content": [
                            { "type": "input_text", "text": "hello" }
                        ]
                    }
                ]
            }),
            &serde_json::json!({
                "stopMessageEnabled": true,
                "stopMessageExcludeDirect": false
            }),
            "openai-responses",
            "client",
        )
        .expect("stopless-enabled direct requests must become relay decisions");

        assert_eq!(decision["providerWireValid"], true);
        assert_eq!(decision["requiresHubRelay"], true);
        assert_eq!(decision["reason"], "servertool_followup_requires_hub_relay");
    }

    #[test]
    fn responses_hosted_tools_remain_direct_on_direct_path() {
        let decision = evaluate_responses_direct_route_decision(
            &serde_json::json!({
                "model": "gpt-5.5",
                "input": [
                    {
                        "role": "user",
                        "content": [
                            { "type": "input_text", "text": "hello" }
                        ]
                    }
                ],
                "tools": [
                    { "type": "web_search_preview" }
                ]
            }),
            &Value::Null,
            "openai-responses",
            "client",
        )
        .expect("hosted Responses tools can stay same-protocol direct");

        assert_eq!(decision["providerWireValid"], true);
        assert_eq!(decision["requiresHubRelay"], false);
        assert_eq!(decision["reason"], Value::Null);
    }

    #[test]
    fn direct_decision_rejects_function_call_output_content_wire() {
        let decision = evaluate_responses_direct_route_decision(
            &serde_json::json!({
                "model": "gpt-5.5",
                "input": [
                    { "role": "user", "content": [{ "type": "input_text", "text": "hello" }] },
                    {
                        "type": "function_call_output",
                        "call_id": "call_1",
                        "output": "ok",
                        "content": [{ "type": "output_text", "text": "illegal duplicate" }]
                    }
                ]
            }),
            &Value::Null,
            "openai-responses",
            "client",
        )
        .expect("direct decision should produce explicit contract result");

        assert_eq!(decision["providerWireValid"], false);
        assert_eq!(decision["requiresHubRelay"], false);
        assert!(decision["reason"]
            .as_str()
            .unwrap_or_default()
            .contains("function_call_output must not include content"));
    }

    #[test]
    fn stop_message_cli_result_requires_hub_relay_on_responses_direct() {
        let decision = evaluate_responses_direct_route_decision(
            &serde_json::json!({
                "model": "gpt-5.5",
                "input": [
                    {
                        "type": "function_call_output",
                        "call_id": "call_servertool_cli_1",
                        "output": "{\"toolName\":\"stop_message_auto\",\"flowId\":\"stop_message_flow\"}"
                    }
                ]
            }),
            &Value::Null,
            "openai-responses",
            "client",
        )
        .expect("stopless CLI result should be a direct decision");

        assert_eq!(decision["providerWireValid"], true);
        assert_eq!(decision["requiresHubRelay"], true);
        assert_eq!(decision["reason"], "servertool_followup_requires_hub_relay");
    }

    #[test]
    fn stop_message_followup_metadata_requires_hub_relay_on_responses_direct() {
        let decision = evaluate_responses_direct_route_decision(
            &serde_json::json!({
                "model": "gpt-5.5",
                "input": [{ "role": "user", "content": [{ "type": "input_text", "text": "continue" }] }]
            }),
            &serde_json::json!({
                "__rt": {
                    "serverToolFollowup": true,
                    "followupSource": "stop_message_auto"
                }
            }),
            "openai-responses",
            "client",
        )
        .expect("stopless followup metadata should be a direct decision");

        assert_eq!(decision["providerWireValid"], true);
        assert_eq!(decision["requiresHubRelay"], true);
        assert_eq!(decision["reason"], "servertool_followup_requires_hub_relay");
    }

    #[test]
    fn generic_servertool_followup_metadata_requires_hub_relay_on_responses_direct() {
        let decision = evaluate_responses_direct_route_decision(
            &serde_json::json!({
                "model": "gpt-5.5",
                "input": [{ "role": "user", "content": [{ "type": "input_text", "text": "continue" }] }]
            }),
            &serde_json::json!({
                "__rt": {
                    "serverToolFollowup": true,
                    "followupSource": "servertool.apply_patch_flow"
                }
            }),
            "openai-responses",
            "client",
        )
        .expect("generic servertool followup metadata should be a direct decision");

        assert_eq!(decision["providerWireValid"], true);
        assert_eq!(decision["requiresHubRelay"], true);
        assert_eq!(decision["reason"], "servertool_followup_requires_hub_relay");
    }
}

use crate::hub_pipeline::{run_hub_pipeline, HubPipelineInput};
use crate::hub_pipeline_blocks::metadata::resolve_stop_message_router_metadata;
use crate::hub_pipeline_blocks::protocol::{
    extract_model_hint_from_metadata, normalize_endpoint, resolve_sse_protocol,
};
use crate::hub_pipeline_blocks::router_metadata_input::build_router_metadata_input;
use crate::hub_pipeline_blocks::standardized_request::coerce_standardized_request_from_payload;
use crate::hub_pipeline_contracts::{
    describe_hub_pipeline_contracts, describe_meta_carrier_contracts, describe_pipeline_contract,
    describe_virtual_router_contracts, validate_pipeline_node_contract_boundary,
};
use crate::server_contracts::{describe_server_contracts, describe_server_module_help};

#[napi_derive::napi]
pub fn normalize_hub_endpoint_json(endpoint: String) -> napi::Result<String> {
    let output = normalize_endpoint(&endpoint);
    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize endpoint: {}", e)))
}

#[napi_derive::napi]
pub fn describe_hub_pipeline_contracts_json() -> napi::Result<String> {
    serde_json::to_string(&describe_hub_pipeline_contracts()).map_err(|e| {
        napi::Error::from_reason(format!("Failed to serialize hub pipeline contracts: {}", e))
    })
}

#[napi_derive::napi]
pub fn describe_virtual_router_contracts_json() -> napi::Result<String> {
    serde_json::to_string(&describe_virtual_router_contracts()).map_err(|e| {
        napi::Error::from_reason(format!(
            "Failed to serialize virtual router contracts: {}",
            e
        ))
    })
}

#[napi_derive::napi]
pub fn describe_meta_carrier_contracts_json() -> napi::Result<String> {
    serde_json::to_string(&describe_meta_carrier_contracts()).map_err(|e| {
        napi::Error::from_reason(format!("Failed to serialize meta carrier contracts: {}", e))
    })
}

#[napi_derive::napi]
pub fn describe_pipeline_contract_json(node_id: String) -> napi::Result<String> {
    let output = describe_pipeline_contract(&node_id).ok_or_else(|| {
        napi::Error::from_reason(format!("unknown pipeline node contract: {node_id}"))
    })?;
    serde_json::to_string(&output).map_err(|e| {
        napi::Error::from_reason(format!("Failed to serialize pipeline contract: {}", e))
    })
}

#[napi_derive::napi]
pub fn validate_pipeline_node_contract_boundary_json(
    node_id: String,
    before_json: String,
    after_json: String,
) -> napi::Result<String> {
    let before: Value = serde_json::from_str(&before_json).map_err(|e| {
        napi::Error::from_reason(format!("Failed to parse boundary before JSON: {}", e))
    })?;
    let after: Value = serde_json::from_str(&after_json).map_err(|e| {
        napi::Error::from_reason(format!("Failed to parse boundary after JSON: {}", e))
    })?;
    let output = validate_pipeline_node_contract_boundary(&node_id, &before, &after)
        .map_err(napi::Error::from_reason)?;
    serde_json::to_string(&output).map_err(|e| {
        napi::Error::from_reason(format!("Failed to serialize boundary validation: {}", e))
    })
}

#[napi_derive::napi]
pub fn resolve_sse_protocol_json(
    metadata_json: String,
    provider_protocol: String,
) -> napi::Result<String> {
    let metadata: Value = serde_json::from_str(&metadata_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse metadata JSON: {}", e)))?;
    let output = resolve_sse_protocol(&metadata, provider_protocol.as_str());
    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize sse protocol: {}", e)))
}

#[napi_derive::napi]
pub fn extract_model_hint_from_metadata_json(metadata_json: String) -> napi::Result<String> {
    let metadata: Value = serde_json::from_str(&metadata_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse metadata JSON: {}", e)))?;
    let output = extract_model_hint_from_metadata(&metadata);
    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize model hint: {}", e)))
}

#[napi_derive::napi]
pub fn has_declared_apply_patch_tool_json(payload_json: String) -> napi::Result<String> {
    let payload: Value = serde_json::from_str(&payload_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse payload JSON: {}", e)))?;
    serde_json::to_string(&serde_json::json!({ "hasDeclaredApplyPatchTool": has_declared_apply_patch_tool(&payload) }))
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize apply_patch tool presence: {}", e)))
}

#[napi_derive::napi]
pub fn evaluate_responses_direct_route_decision_json(
    payload_json: String,
    metadata_json: String,
    inbound_protocol_json: String,
    apply_patch_mode_json: String,
) -> napi::Result<String> {
    let payload: Value = serde_json::from_str(&payload_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse payload JSON: {}", e)))?;
    let metadata: Value = serde_json::from_str(&metadata_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse metadata JSON: {}", e)))?;
    let inbound_protocol: Value = serde_json::from_str(&inbound_protocol_json).map_err(|e| {
        napi::Error::from_reason(format!("Failed to parse inbound protocol JSON: {}", e))
    })?;
    let apply_patch_mode: Value = serde_json::from_str(&apply_patch_mode_json).map_err(|e| {
        napi::Error::from_reason(format!("Failed to parse apply patch mode JSON: {}", e))
    })?;
    let output = evaluate_responses_direct_route_decision(
        &payload,
        &metadata,
        inbound_protocol.as_str().unwrap_or(""),
        apply_patch_mode.as_str().unwrap_or(""),
    )
    .map_err(napi::Error::from_reason)?;
    serde_json::to_string(&output).map_err(|e| {
        napi::Error::from_reason(format!(
            "Failed to serialize responses direct route decision: {}",
            e
        ))
    })
}

#[napi_derive::napi]
pub fn resolve_stop_message_router_metadata_json(metadata_json: String) -> napi::Result<String> {
    let metadata: Value = serde_json::from_str(&metadata_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse metadata JSON: {}", e)))?;
    let output = resolve_stop_message_router_metadata(&metadata);
    serde_json::to_string(&output).map_err(|e| {
        napi::Error::from_reason(format!(
            "Failed to serialize stop-message router metadata: {}",
            e
        ))
    })
}

#[napi_derive::napi]
pub fn build_router_metadata_input_json(input_json: String) -> napi::Result<String> {
    let input: Value = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input JSON: {}", e)))?;
    let output = build_router_metadata_input(&input).map_err(|e| {
        napi::Error::from_reason(format!("Failed to build router metadata input: {}", e))
    })?;
    serde_json::to_string(&output).map_err(|e| {
        napi::Error::from_reason(format!("Failed to serialize router metadata input: {}", e))
    })
}

#[napi_derive::napi]
pub fn coerce_standardized_request_from_payload_json(input_json: String) -> napi::Result<String> {
    let input: Value = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input JSON: {}", e)))?;
    let output = coerce_standardized_request_from_payload(&input).map_err(|e| {
        napi::Error::from_reason(format!(
            "Failed to coerce standardized request from payload: {}",
            e
        ))
    })?;
    serde_json::to_string(&output).map_err(|e| {
        napi::Error::from_reason(format!(
            "Failed to serialize standardized request coercion output: {}",
            e
        ))
    })
}

// NAPI bindings
#[napi_derive::napi]
pub fn run_hub_pipeline_json(input_json: String) -> napi::Result<String> {
    if input_json.trim().is_empty() {
        return Err(napi::Error::from_reason("Input JSON is empty"));
    }

    let input: HubPipelineInput = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input JSON: {}", e)))?;

    let output = run_hub_pipeline(input).map_err(|e| napi::Error::from_reason(e))?;

    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)))
}

#[napi_derive::napi]
pub fn describe_server_contracts_json() -> napi::Result<String> {
    serde_json::to_string(&describe_server_contracts()).map_err(|e| {
        napi::Error::from_reason(format!("Failed to serialize server contracts: {}", e))
    })
}

#[napi_derive::napi]
pub fn describe_server_module_help_json(module_id: String) -> napi::Result<String> {
    let output = describe_server_module_help(&module_id).ok_or_else(|| {
        napi::Error::from_reason(format!("unknown server module help: {module_id}"))
    })?;
    serde_json::to_string(&output).map_err(|e| {
        napi::Error::from_reason(format!("Failed to serialize server module help: {}", e))
    })
}
