use serde_json::Value;

use super::protocol::{
    resolve_hub_pipeline_request_provider_protocol,
    resolve_provider_protocol_from_metadata_snapshot,
};
use crate::metadata_center::{build_metadata_center_from_snapshot, MetadataCenterReader};

fn as_object_map(value: Option<&Value>) -> Option<&serde_json::Map<String, Value>> {
    value.and_then(Value::as_object)
}

fn non_empty_object(value: Option<&Value>) -> Option<Value> {
    let object = as_object_map(value)?;
    if object.is_empty() {
        None
    } else {
        Some(Value::Object(object.clone()))
    }
}

fn read_trimmed_string(value: Option<&Value>) -> Option<String> {
    value?
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn read_trimmed_lower_string(value: Option<&Value>) -> Option<String> {
    read_trimmed_string(value).map(|value| value.to_ascii_lowercase())
}

pub fn build_hub_pipeline_materialized_request_plan(input: &Value) -> Result<Value, String> {
    let row = input.as_object().ok_or_else(|| {
        "Rust HubPipeline materialized request plan input must be object".to_string()
    })?;
    let request_endpoint = read_trimmed_string(row.get("endpoint"))
        .ok_or_else(|| "Rust HubPipeline materialized request plan missing endpoint".to_string())?;
    let metadata = row
        .get("metadata")
        .and_then(Value::as_object)
        .ok_or_else(|| "Rust HubPipeline materialized request plan missing metadata".to_string())?;
    let provider_protocol = read_trimmed_string(row.get("providerProtocol")).ok_or_else(|| {
        "Rust HubPipeline materialized request plan missing providerProtocol".to_string()
    })?;
    let payload_stream = row
        .get("payloadStream")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let payload_declares_stream = row
        .get("payload")
        .and_then(Value::as_object)
        .and_then(|payload| payload.get("stream"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let endpoint = read_trimmed_string(metadata.get("endpoint")).unwrap_or(request_endpoint);
    let entry_endpoint =
        read_trimmed_string(metadata.get("entryEndpoint")).unwrap_or_else(|| endpoint.clone());
    let direction = match read_trimmed_lower_string(metadata.get("direction")).as_deref() {
        Some("response") => "response",
        _ => "request",
    };
    let stage = match read_trimmed_lower_string(metadata.get("stage")).as_deref() {
        Some("outbound") => "outbound",
        _ => "inbound",
    };
    let hub_entry_mode = match read_trimmed_lower_string(metadata.get("__hubEntry")).as_deref() {
        Some("chat_process") | Some("chat-process") | Some("chatprocess") => {
            Some(Value::String("chat_process".to_string()))
        }
        _ => None,
    };
    let policy_override = metadata
        .get("__hubPolicyOverride")
        .and_then(Value::as_object)
        .map(|value| Value::Object(value.clone()));
    let shadow_compare = metadata
        .get("__hubShadowCompare")
        .and_then(Value::as_object)
        .map(|value| Value::Object(value.clone()));
    let disable_snapshots = metadata
        .get("__disableHubSnapshots")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let stream = metadata
        .get("stream")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || payload_declares_stream
        || payload_stream;
    let mut output_metadata = metadata.clone();
    output_metadata.insert("endpoint".to_string(), Value::String(endpoint.clone()));
    output_metadata.insert(
        "entryEndpoint".to_string(),
        Value::String(entry_endpoint.clone()),
    );
    output_metadata.insert(
        "providerProtocol".to_string(),
        Value::String(provider_protocol.clone()),
    );
    output_metadata.insert("stream".to_string(), Value::Bool(stream));
    output_metadata.insert("processMode".to_string(), Value::String("chat".to_string()));
    output_metadata.insert(
        "direction".to_string(),
        Value::String(direction.to_string()),
    );
    output_metadata.insert("stage".to_string(), Value::String(stage.to_string()));
    output_metadata.remove("__hubEntry");
    output_metadata.remove("__hubPolicyOverride");
    output_metadata.remove("__hubShadowCompare");
    output_metadata.remove("__disableHubSnapshots");

    let mut output = serde_json::Map::new();
    output.insert("endpoint".to_string(), Value::String(endpoint));
    output.insert("entryEndpoint".to_string(), Value::String(entry_endpoint));
    output.insert(
        "providerProtocol".to_string(),
        Value::String(provider_protocol),
    );
    output.insert("metadata".to_string(), Value::Object(output_metadata));
    output.insert("processMode".to_string(), Value::String("chat".to_string()));
    output.insert(
        "direction".to_string(),
        Value::String(direction.to_string()),
    );
    output.insert("stage".to_string(), Value::String(stage.to_string()));
    output.insert("stream".to_string(), Value::Bool(stream));
    output.insert(
        "disableSnapshots".to_string(),
        Value::Bool(disable_snapshots),
    );
    if let Some(value) = hub_entry_mode {
        output.insert("hubEntryMode".to_string(), value);
    }
    if let Some(value) = policy_override {
        output.insert("policyOverride".to_string(), value);
    }
    if let Some(value) = shadow_compare {
        output.insert("shadowCompare".to_string(), value);
    }

    Ok(Value::Object(output))
}

fn normalize_string_array(value: Option<&Value>) -> Option<Value> {
    let array = value?.as_array()?;
    let normalized: Vec<Value> = array
        .iter()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| Value::String(value.to_string()))
        .collect();
    if normalized.is_empty() {
        None
    } else {
        Some(Value::Array(normalized))
    }
}

pub fn build_request_stage_metadata_dispatch(input: &Value) -> Result<Value, String> {
    let row = input
        .as_object()
        .ok_or_else(|| "Rust request-stage metadata dispatch input must be object".to_string())?;
    let source_metadata = row
        .get("sourceMetadata")
        .and_then(Value::as_object)
        .ok_or_else(|| "Rust request-stage metadata dispatch missing sourceMetadata".to_string())?;
    let mut metadata_base = source_metadata.clone();
    metadata_base.remove("__rt");
    metadata_base.remove("__metadataCenter");

    let runtime_control_payload = source_metadata
        .get("runtime_control")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let metadata_center_runtime_control = row
        .get("runtimeControl")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut merged_runtime_control = runtime_control_payload;
    for (key, value) in metadata_center_runtime_control.iter() {
        merged_runtime_control.insert(key.clone(), value.clone());
    }
    metadata_base.insert(
        "runtime_control".to_string(),
        Value::Object(merged_runtime_control),
    );

    let provider_protocol = read_trimmed_string(row.get("providerProtocol"));
    let mut snapshot = serde_json::Map::new();
    if let Some(request_truth) = non_empty_object(row.get("requestTruth")) {
        snapshot.insert("requestTruth".to_string(), request_truth);
    }
    if let Some(continuation_context) = non_empty_object(row.get("continuationContext")) {
        snapshot.insert("continuationContext".to_string(), continuation_context);
    }
    let mut snapshot_runtime_control = metadata_center_runtime_control;
    if let Some(provider_protocol) = provider_protocol {
        snapshot_runtime_control.insert(
            "providerProtocol".to_string(),
            Value::String(provider_protocol),
        );
    }
    if !snapshot_runtime_control.is_empty() {
        snapshot.insert(
            "runtimeControl".to_string(),
            Value::Object(snapshot_runtime_control),
        );
    }
    if let Some(excluded_provider_keys) = normalize_string_array(row.get("excludedProviderKeys")) {
        snapshot.insert("excludedProviderKeys".to_string(), excluded_provider_keys);
    }

    Ok(serde_json::json!({
        "metadata": Value::Object(metadata_base),
        "metadataCenterSnapshot": if snapshot.is_empty() { Value::Null } else { Value::Object(snapshot) }
    }))
}

fn optional_non_empty_object(value: Option<&Value>) -> Option<Value> {
    let object = value?.as_object()?;
    if object.is_empty() {
        None
    } else {
        Some(Value::Object(object.clone()))
    }
}

pub fn build_provider_response_metadata_snapshot(input: &Value) -> Result<Value, String> {
    let row = input.as_object().ok_or_else(|| {
        "Rust provider-response metadata snapshot input must be object".to_string()
    })?;
    let has_bound_metadata_center = row
        .get("hasBoundMetadataCenter")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let metadata_center_snapshot = if has_bound_metadata_center {
        let mut snapshot = serde_json::Map::new();
        if let Some(request_truth) = optional_non_empty_object(row.get("requestTruth")) {
            snapshot.insert("requestTruth".to_string(), request_truth);
        }
        if let Some(continuation_context) =
            optional_non_empty_object(row.get("continuationContext"))
        {
            snapshot.insert("continuationContext".to_string(), continuation_context);
        }
        if let Some(runtime_control) = optional_non_empty_object(row.get("runtimeControl")) {
            snapshot.insert("runtimeControl".to_string(), runtime_control);
        }
        if snapshot.is_empty() {
            Value::Null
        } else {
            Value::Object(snapshot)
        }
    } else if let Some(direct) = optional_non_empty_object(row.get("directMetadataCenterSnapshot"))
    {
        direct
    } else if let Some(nested) = optional_non_empty_object(row.get("nestedMetadataCenterSnapshot"))
    {
        nested
    } else {
        Value::Null
    };

    Ok(serde_json::json!({
        "metadataCenterSnapshot": metadata_center_snapshot
    }))
}

pub fn build_provider_response_metadata_snapshot_json(input_json: String) -> napi::Result<String> {
    let value: Value = serde_json::from_str(&input_json).map_err(|error| {
        napi::Error::from_reason(format!(
            "invalid provider-response metadata snapshot JSON: {error}"
        ))
    })?;
    let output =
        build_provider_response_metadata_snapshot(&value).map_err(napi::Error::from_reason)?;
    serde_json::to_string(&output).map_err(|error| {
        napi::Error::from_reason(format!(
            "serialize provider-response metadata snapshot failed: {error}"
        ))
    })
}

pub fn build_request_stage_metadata_dispatch_json(input_json: String) -> napi::Result<String> {
    let value: Value = serde_json::from_str(&input_json).map_err(|error| {
        napi::Error::from_reason(format!(
            "invalid request-stage metadata dispatch JSON: {error}"
        ))
    })?;
    let output = build_request_stage_metadata_dispatch(&value).map_err(napi::Error::from_reason)?;
    serde_json::to_string(&output).map_err(|error| {
        napi::Error::from_reason(format!(
            "serialize request-stage metadata dispatch failed: {error}"
        ))
    })
}

pub fn build_hub_pipeline_materialized_request_plan_json(
    input_json: String,
) -> napi::Result<String> {
    let value: Value = serde_json::from_str(&input_json).map_err(|error| {
        napi::Error::from_reason(format!(
            "invalid HubPipeline materialized request plan JSON: {error}"
        ))
    })?;
    let output =
        build_hub_pipeline_materialized_request_plan(&value).map_err(napi::Error::from_reason)?;
    serde_json::to_string(&output).map_err(|error| {
        napi::Error::from_reason(format!(
            "serialize HubPipeline materialized request plan failed: {error}"
        ))
    })
}

pub fn build_request_stage_runtime_control_write_plan(input: &Value) -> Result<Value, String> {
    let row = input.as_object().ok_or_else(|| {
        "Rust request-stage runtime-control write plan input must be object".to_string()
    })?;
    let runtime_control = row
        .get("outputMetadata")
        .and_then(Value::as_object)
        .and_then(|metadata| metadata.get("runtime_control"))
        .and_then(Value::as_object)
        .filter(|runtime_control| !runtime_control.is_empty())
        .map(|runtime_control| Value::Object(runtime_control.clone()))
        .unwrap_or(Value::Null);

    Ok(serde_json::json!({
        "runtimeControl": runtime_control
    }))
}

pub fn build_request_stage_runtime_control_write_plan_json(
    input_json: String,
) -> napi::Result<String> {
    let value: Value = serde_json::from_str(&input_json).map_err(|error| {
        napi::Error::from_reason(format!(
            "invalid request-stage runtime-control write plan JSON: {error}"
        ))
    })?;
    let output =
        build_request_stage_runtime_control_write_plan(&value).map_err(napi::Error::from_reason)?;
    serde_json::to_string(&output).map_err(|error| {
        napi::Error::from_reason(format!(
            "serialize request-stage runtime-control write plan failed: {error}"
        ))
    })
}

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
    if inbound_protocol == "openai-responses" && stop_message_requires_hub_relay(metadata) {
        return Ok(serde_json::json!({
            "providerWireValid": true,
            "requiresHubRelay": true,
            "reason": "servertool_followup_requires_hub_relay",
            "hasDeclaredApplyPatchTool": has_declared_apply_patch_tool
        }));
    }
    Ok(serde_json::json!({
        "providerWireValid": true,
        "requiresHubRelay": false,
        "reason": null,
        "hasDeclaredApplyPatchTool": has_declared_apply_patch_tool
    }))
}

fn stop_message_requires_hub_relay(metadata: &Value) -> bool {
    let Some(root) = metadata.as_object() else {
        return false;
    };
    let center = root
        .get("metadataCenterSnapshot")
        .map(build_metadata_center_from_snapshot);
    let stop_message_enabled = center
        .as_ref()
        .and_then(MetadataCenterReader::stop_message_enabled)
        .unwrap_or(false);
    if !stop_message_enabled {
        return false;
    }
    !center
        .as_ref()
        .and_then(MetadataCenterReader::stop_message_exclude_direct)
        .unwrap_or(true)
}

fn read_trimmed_lower(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?.trim().to_ascii_lowercase();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

pub fn resolve_provider_protocol_json(input_json: String) -> napi::Result<String> {
    let input: Value = serde_json::from_str(&input_json).map_err(|error| {
        napi::Error::from_reason(format!("invalid providerProtocol resolver JSON: {error}"))
    })?;
    let output = resolve_provider_protocol_from_metadata_snapshot(&input)
        .map_err(napi::Error::from_reason)?;
    serde_json::to_string(&output).map_err(|error| {
        napi::Error::from_reason(format!(
            "serialize providerProtocol resolver failed: {error}"
        ))
    })
}

pub fn resolve_hub_pipeline_request_provider_protocol_json(
    input_json: String,
) -> napi::Result<String> {
    let input: Value = serde_json::from_str(&input_json).map_err(|error| {
        napi::Error::from_reason(format!(
            "invalid HubPipeline request providerProtocol resolver JSON: {error}"
        ))
    })?;
    let output =
        resolve_hub_pipeline_request_provider_protocol(&input).map_err(napi::Error::from_reason)?;
    serde_json::to_string(&output).map_err(|error| {
        napi::Error::from_reason(format!(
            "serialize HubPipeline request providerProtocol resolver failed: {error}"
        ))
    })
}

#[cfg(test)]
mod responses_direct_route_decision_tests {
    use super::*;

    #[test]
    fn builds_request_stage_metadata_dispatch_in_rust() {
        let output = build_request_stage_metadata_dispatch(&serde_json::json!({
            "sourceMetadata": {
                "requestId": "req-1",
                "__rt": { "preselectedRoute": { "target": "legacy" } },
                "__metadataCenter": { "private": true },
                "runtime_control": {
                    "preselectedRoute": { "target": "payload" },
                    "retryProviderKey": "payload.retry"
                },
                "excludedProviderKeys": [" provider.a ", "", 9, "provider.b"]
            },
            "requestTruth": { "sessionId": "sess-1" },
            "continuationContext": { "responsesResume": { "responseId": "resp-1" } },
            "runtimeControl": {
                "retryProviderKey": "center.retry"
            },
            "providerProtocol": " openai-responses ",
            "excludedProviderKeys": [" provider.a ", "", 9, "provider.b"]
        }))
        .unwrap();

        assert!(output["metadata"].get("__rt").is_none());
        assert!(output["metadata"].get("__metadataCenter").is_none());
        assert_eq!(
            output["metadata"]["runtime_control"]["preselectedRoute"],
            serde_json::json!({ "target": "payload" })
        );
        assert_eq!(
            output["metadata"]["runtime_control"]["retryProviderKey"],
            serde_json::json!("center.retry")
        );
        assert_eq!(
            output["metadataCenterSnapshot"],
            serde_json::json!({
                "requestTruth": { "sessionId": "sess-1" },
                "continuationContext": { "responsesResume": { "responseId": "resp-1" } },
                "runtimeControl": {
                    "retryProviderKey": "center.retry",
                    "providerProtocol": "openai-responses"
                },
                "excludedProviderKeys": ["provider.a", "provider.b"]
            })
        );
    }

    #[test]
    fn builds_hub_pipeline_materialized_request_plan_in_rust() {
        let output = build_hub_pipeline_materialized_request_plan(&serde_json::json!({
            "endpoint": "/v1/chat/completions",
            "providerProtocol": "openai-responses",
            "payloadStream": false,
            "payload": { "stream": true },
            "metadata": {
                "endpoint": " /v1/responses ",
                "entryEndpoint": " /v1/responses ",
                "direction": "response",
                "stage": "outbound",
                "__hubEntry": "chat-process",
                "__hubPolicyOverride": { "mode": "strict" },
                "__hubShadowCompare": { "enabled": true },
                "__disableHubSnapshots": true,
                "keep": "value"
            }
        }))
        .unwrap();

        assert_eq!(output["endpoint"], serde_json::json!("/v1/responses"));
        assert_eq!(output["entryEndpoint"], serde_json::json!("/v1/responses"));
        assert_eq!(
            output["providerProtocol"],
            serde_json::json!("openai-responses")
        );
        assert_eq!(output["processMode"], serde_json::json!("chat"));
        assert_eq!(output["direction"], serde_json::json!("response"));
        assert_eq!(output["stage"], serde_json::json!("outbound"));
        assert_eq!(output["stream"], serde_json::json!(true));
        assert_eq!(output["disableSnapshots"], serde_json::json!(true));
        assert_eq!(output["hubEntryMode"], serde_json::json!("chat_process"));
        assert_eq!(
            output["policyOverride"],
            serde_json::json!({ "mode": "strict" })
        );
        assert_eq!(
            output["shadowCompare"],
            serde_json::json!({ "enabled": true })
        );
        assert_eq!(output["metadata"]["keep"], serde_json::json!("value"));
        assert!(output["metadata"].get("__hubEntry").is_none());
        assert!(output["metadata"].get("__hubPolicyOverride").is_none());
        assert!(output["metadata"].get("__hubShadowCompare").is_none());
        assert!(output["metadata"].get("__disableHubSnapshots").is_none());
    }

    #[test]
    fn rejects_hub_pipeline_materialized_request_plan_without_endpoint() {
        let error = build_hub_pipeline_materialized_request_plan(&serde_json::json!({
            "providerProtocol": "openai-chat",
            "metadata": {}
        }))
        .unwrap_err();

        assert!(error.contains("missing endpoint"));
    }

    #[test]
    fn request_stage_metadata_dispatch_omits_empty_snapshot() {
        let output = build_request_stage_metadata_dispatch(&serde_json::json!({
            "sourceMetadata": {
                "requestId": "req-1"
            },
            "requestTruth": {},
            "continuationContext": {},
            "runtimeControl": {},
            "providerProtocol": "",
            "excludedProviderKeys": []
        }))
        .unwrap();

        assert_eq!(output["metadata"]["runtime_control"], serde_json::json!({}));
        assert_eq!(output["metadataCenterSnapshot"], Value::Null);
    }

    #[test]
    fn provider_response_metadata_snapshot_prefers_bound_center_families() {
        let output = build_provider_response_metadata_snapshot(&serde_json::json!({
            "hasBoundMetadataCenter": true,
            "requestTruth": { "requestId": "req-center" },
            "continuationContext": {},
            "runtimeControl": { "providerProtocol": "anthropic-messages" },
            "directMetadataCenterSnapshot": {
                "runtimeControl": { "providerProtocol": "openai-chat" }
            },
            "nestedMetadataCenterSnapshot": {
                "runtimeControl": { "providerProtocol": "openai-responses" }
            }
        }))
        .unwrap();

        assert_eq!(
            output["metadataCenterSnapshot"],
            serde_json::json!({
                "requestTruth": { "requestId": "req-center" },
                "runtimeControl": { "providerProtocol": "anthropic-messages" }
            })
        );
    }

    #[test]
    fn provider_response_metadata_snapshot_uses_direct_then_nested_carrier_without_center() {
        let direct = build_provider_response_metadata_snapshot(&serde_json::json!({
            "hasBoundMetadataCenter": false,
            "requestTruth": { "requestId": "ignored" },
            "runtimeControl": { "providerProtocol": "ignored" },
            "directMetadataCenterSnapshot": {
                "runtimeControl": { "providerProtocol": "direct" }
            },
            "nestedMetadataCenterSnapshot": {
                "runtimeControl": { "providerProtocol": "nested" }
            }
        }))
        .unwrap();
        assert_eq!(
            direct["metadataCenterSnapshot"],
            serde_json::json!({
                "runtimeControl": { "providerProtocol": "direct" }
            })
        );

        let nested = build_provider_response_metadata_snapshot(&serde_json::json!({
            "hasBoundMetadataCenter": false,
            "directMetadataCenterSnapshot": {},
            "nestedMetadataCenterSnapshot": {
                "runtimeControl": { "providerProtocol": "nested" }
            }
        }))
        .unwrap();
        assert_eq!(
            nested["metadataCenterSnapshot"],
            serde_json::json!({
                "runtimeControl": { "providerProtocol": "nested" }
            })
        );
    }

    #[test]
    fn request_stage_runtime_control_write_plan_extracts_non_empty_runtime_control() {
        let output = build_request_stage_runtime_control_write_plan(&serde_json::json!({
            "outputMetadata": {
                "target": { "providerKey": "provider.a" },
                "runtime_control": {
                    "stopless": { "flowId": "flow-1" }
                }
            }
        }))
        .unwrap();

        assert_eq!(
            output["runtimeControl"],
            serde_json::json!({
                "stopless": { "flowId": "flow-1" }
            })
        );
    }

    #[test]
    fn request_stage_runtime_control_write_plan_omits_missing_or_empty_runtime_control() {
        let missing = build_request_stage_runtime_control_write_plan(&serde_json::json!({
            "outputMetadata": {
                "target": { "providerKey": "provider.a" }
            }
        }))
        .unwrap();
        assert_eq!(missing["runtimeControl"], Value::Null);

        let empty = build_request_stage_runtime_control_write_plan(&serde_json::json!({
            "outputMetadata": {
                "runtime_control": {}
            }
        }))
        .unwrap();
        assert_eq!(empty["runtimeControl"], Value::Null);
    }

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
                "metadataCenterSnapshot": {
                    "runtimeControl": {
                        "stopMessage": {
                            "enabled": true,
                            "excludeDirect": true
                        }
                    }
                }
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
    fn responses_client_tools_prefer_metadata_center_stop_message_controls_for_direct_decision() {
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
                "metadataCenterSnapshot": {
                    "runtimeControl": {
                        "stopMessage": {
                            "enabled": true,
                            "excludeDirect": true
                        }
                    }
                }
            }),
            "openai-responses",
            "client",
        )
        .expect("metadata-center stop-message controls should drive direct decision first");

        assert_eq!(decision["providerWireValid"], true);
        assert_eq!(decision["requiresHubRelay"], false);
        assert_eq!(decision["reason"], Value::Null);
    }

    #[test]
    fn responses_request_requires_hub_relay_when_stop_message_includes_direct() {
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
                "metadataCenterSnapshot": {
                    "runtimeControl": {
                        "stopMessage": {
                            "enabled": true,
                            "excludeDirect": false
                        }
                    }
                }
            }),
            "openai-responses",
            "client",
        )
        .expect("stopless includeDirect requires relay into Hub Chat Process");

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
    fn stop_message_cli_result_stays_direct_on_responses_direct() {
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
        .expect("stopless CLI result direct decision should stay direct");

        assert_eq!(decision["providerWireValid"], true);
        assert_eq!(decision["requiresHubRelay"], false);
        assert_eq!(decision["reason"], Value::Null);
    }

    #[test]
    fn stop_message_followup_metadata_stays_direct_on_responses_direct() {
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
        .expect("stopless followup metadata direct decision should stay direct");

        assert_eq!(decision["providerWireValid"], true);
        assert_eq!(decision["requiresHubRelay"], false);
        assert_eq!(decision["reason"], Value::Null);
    }

    #[test]
    fn legacy_rt_stop_message_toggle_does_not_control_direct_decision() {
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
                "__rt": {
                    "stopMessageEnabled": true,
                    "stopMessageExcludeDirect": true
                }
            }),
            "openai-responses",
            "client",
        )
        .expect("legacy rt stop-message residue must not drive same-protocol direct decision");

        assert_eq!(decision["providerWireValid"], true);
        assert_eq!(decision["requiresHubRelay"], false);
        assert_eq!(decision["reason"], Value::Null);
    }

    #[test]
    fn generic_servertool_followup_metadata_stays_direct_on_responses_direct() {
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
        .expect("generic servertool followup metadata direct decision should stay direct");

        assert_eq!(decision["providerWireValid"], true);
        assert_eq!(decision["requiresHubRelay"], false);
        assert_eq!(decision["reason"], Value::Null);
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
