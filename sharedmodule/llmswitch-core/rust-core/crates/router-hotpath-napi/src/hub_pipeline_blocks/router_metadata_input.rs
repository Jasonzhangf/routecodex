use crate::hub_pipeline_blocks::metadata::{
    resolve_router_metadata_runtime_flags, resolve_stop_message_router_metadata,
};
// feature_id: hub.route_metadata_surface
use crate::hub_pipeline_blocks::responses_resume::{
    read_continuation_from_semantics_node, read_responses_resume_from_semantics_node,
    synthesize_continuation_from_responses_resume,
};
use serde_json::{Map, Value};

fn read_snapshot_runtime_control_retry_provider_key(row: &Map<String, Value>) -> Option<&Value> {
    row.get("metadataCenterSnapshot")
        .and_then(|value| value.as_object())
        .and_then(|snapshot| snapshot.get("runtimeControl"))
        .and_then(|value| value.as_object())
        .and_then(|runtime_control| runtime_control.get("retryProviderKey"))
}

fn read_snapshot_runtime_control_provider_protocol(row: &Map<String, Value>) -> Option<String> {
    row.get("metadataCenterSnapshot")
        .and_then(|value| value.as_object())
        .and_then(|snapshot| snapshot.get("runtimeControl"))
        .and_then(|value| value.as_object())
        .and_then(|runtime_control| runtime_control.get("providerProtocol"))
        .and_then(|value| value.as_str())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn read_snapshot_runtime_control_route_hint(row: &Map<String, Value>) -> Option<String> {
    row.get("metadataCenterSnapshot")
        .and_then(|value| value.as_object())
        .and_then(|snapshot| snapshot.get("runtimeControl"))
        .and_then(|value| value.as_object())
        .and_then(|runtime_control| runtime_control.get("routeHint"))
        .and_then(|value| value.as_str())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn read_snapshot_request_truth_string(row: &Map<String, Value>, key: &str) -> Option<String> {
    row.get("metadataCenterSnapshot")
        .and_then(|value| value.as_object())
        .and_then(|snapshot| snapshot.get("requestTruth"))
        .and_then(|value| value.as_object())
        .and_then(|request_truth| request_truth.get(key))
        .and_then(|value| value.as_str())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn read_snapshot_continuation_context_responses_resume(row: &Map<String, Value>) -> Option<Value> {
    row.get("metadataCenterSnapshot")
        .and_then(|value| value.as_object())
        .and_then(|snapshot| snapshot.get("continuationContext"))
        .and_then(|value| value.as_object())
        .and_then(|continuation_context| continuation_context.get("responsesResume"))
        .filter(|value| value.is_object())
        .cloned()
}

fn read_continuation_owner(value: Option<&Value>) -> Option<String> {
    value
        .and_then(|node| node.as_object())
        .and_then(|row| row.get("continuationOwner"))
        .and_then(|value| value.as_str())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn read_retry_exclusion_set(row: &Map<String, Value>) -> Result<Option<Value>, String> {
    let Some(value) = row.get("retryExclusionSet") else {
        return Ok(None);
    };
    let entries = value
        .as_array()
        .ok_or_else(|| "router retryExclusionSet must be an array".to_string())?;
    let mut normalized = Vec::with_capacity(entries.len());
    for entry in entries {
        let provider_key = entry
            .as_str()
            .map(str::trim)
            .filter(|provider_key| !provider_key.is_empty())
            .ok_or_else(|| {
                "router retryExclusionSet entries must be non-empty strings".to_string()
            })?;
        if normalized
            .iter()
            .any(|existing: &Value| existing.as_str() == Some(provider_key))
        {
            return Err(format!(
                "router retryExclusionSet contains duplicate provider key: {provider_key}"
            ));
        }
        normalized.push(Value::String(provider_key.to_string()));
    }
    Ok((!normalized.is_empty()).then_some(Value::Array(normalized)))
}

pub(crate) fn build_router_metadata_input(input: &Value) -> Result<Value, String> {
    let row = input
        .as_object()
        .ok_or_else(|| "router metadata input must be object".to_string())?;
    let request_id = row
        .get("requestId")
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .ok_or_else(|| "requestId is required".to_string())?;
    let entry_endpoint = row
        .get("entryEndpoint")
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "/v1/chat/completions".to_string());
    let process_mode = row
        .get("processMode")
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_ascii_lowercase())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "chat".to_string());
    let direction = row
        .get("direction")
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_ascii_lowercase())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "request".to_string());
    let provider_protocol = read_snapshot_runtime_control_provider_protocol(row);
    let stream = row.get("stream").and_then(|v| v.as_bool()).unwrap_or(false);
    let metadata_node = row.get("metadata").unwrap_or(&Value::Null);
    let request_semantics = row.get("requestSemantics");
    let stop_message_metadata = resolve_stop_message_router_metadata(metadata_node);
    let runtime_flags = resolve_router_metadata_runtime_flags(metadata_node);
    let include_estimated_input_tokens = row
        .get("includeEstimatedInputTokens")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let responses_resume_from_semantics =
        read_responses_resume_from_semantics_node(request_semantics);
    let responses_resume_from_snapshot = read_snapshot_continuation_context_responses_resume(row);
    let responses_resume_for_output = responses_resume_from_snapshot
        .clone()
        .or_else(|| responses_resume_from_semantics.clone());
    let continuation = read_continuation_from_semantics_node(request_semantics).or_else(|| {
        synthesize_continuation_from_responses_resume(responses_resume_for_output.as_ref())
    });

    let mut out = Map::<String, Value>::new();
    out.insert("requestId".to_string(), Value::String(request_id));
    out.insert("entryEndpoint".to_string(), Value::String(entry_endpoint));
    out.insert("processMode".to_string(), Value::String(process_mode));
    out.insert("stream".to_string(), Value::Bool(stream));
    out.insert("direction".to_string(), Value::String(direction));
    if let Some(provider_protocol) = provider_protocol {
        out.insert(
            "providerProtocol".to_string(),
            Value::String(provider_protocol),
        );
    }

    if let Some(route_hint) = read_snapshot_runtime_control_route_hint(row) {
        out.insert("routeHint".to_string(), Value::String(route_hint));
    }
    if let Some(stage) = row
        .get("stage")
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_ascii_lowercase())
        .filter(|v| v == "inbound" || v == "outbound")
    {
        out.insert("stage".to_string(), Value::String(stage));
    }
    if let Some(session_id) = read_snapshot_request_truth_string(row, "sessionId") {
        out.insert("sessionId".to_string(), Value::String(session_id));
    }
    if let Some(conversation_id) = read_snapshot_request_truth_string(row, "conversationId") {
        out.insert("conversationId".to_string(), Value::String(conversation_id));
    }
    if row
        .get("serverToolRequired")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        out.insert("serverToolRequired".to_string(), Value::Bool(true));
    }
    if let Some(continuation) = continuation.as_ref() {
        out.insert("continuation".to_string(), continuation.clone());
    }
    if let Some(stop_obj) = stop_message_metadata.as_object() {
        for (key, value) in stop_obj {
            out.insert(key.clone(), value.clone());
        }
    }
    if let Some(runtime_flags_obj) = runtime_flags.as_object() {
        if include_estimated_input_tokens {
            if let Some(value) = runtime_flags_obj.get("estimatedInputTokens") {
                out.insert("estimatedInputTokens".to_string(), value.clone());
            }
        }
    }

    if let Some(retry_provider_key) = read_snapshot_runtime_control_retry_provider_key(row)
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
    {
        out.insert(
            "retryProviderKey".to_string(),
            Value::String(retry_provider_key),
        );
    }
    if let Some(retry_exclusion_set) = read_retry_exclusion_set(row)? {
        out.insert("excludedProviderKeys".to_string(), retry_exclusion_set);
    }

    if let Some(metadata_obj) = metadata_node.as_object() {
        if let Some(route_policy_group) = metadata_obj
            .get("routecodexRoutingPolicyGroup")
            .and_then(|v| v.as_str())
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
        {
            out.insert(
                "routecodexRoutingPolicyGroup".to_string(),
                Value::String(route_policy_group),
            );
        }

        if let Some(routecodex_local_port) = metadata_obj
            .get("routecodexLocalPort")
            .and_then(|v| v.as_i64())
        {
            out.insert(
                "routecodexLocalPort".to_string(),
                Value::Number(routecodex_local_port.into()),
            );
        }

        if let Some(routecodex_port_mode) = metadata_obj
            .get("routecodexPortMode")
            .and_then(|v| v.as_str())
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
        {
            out.insert(
                "routecodexPortMode".to_string(),
                Value::String(routecodex_port_mode),
            );
        }

        if let Some(routecodex_port_binding) = metadata_obj
            .get("routecodexPortBinding")
            .and_then(|v| v.as_str())
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
        {
            out.insert(
                "routecodexPortBinding".to_string(),
                Value::String(routecodex_port_binding),
            );
        }

        if let Some(allowed_providers) = metadata_obj
            .get("allowedProviders")
            .and_then(|v| v.as_array())
        {
            let normalized: Vec<Value> = allowed_providers
                .iter()
                .filter_map(|entry| entry.as_str())
                .map(|entry| entry.trim().to_string())
                .filter(|entry| !entry.is_empty())
                .map(Value::String)
                .collect();
            if !normalized.is_empty() {
                out.insert("allowedProviders".to_string(), Value::Array(normalized));
            }
        }

        if let Some(forced_provider_key) = metadata_obj
            .get("__shadowCompareForcedProviderKey")
            .and_then(|v| v.as_str())
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
        {
            out.insert(
                "__shadowCompareForcedProviderKey".to_string(),
                Value::String(forced_provider_key),
            );
        }

        if let Some(disabled_aliases) = metadata_obj
            .get("disabledProviderKeyAliases")
            .and_then(|v| v.as_array())
        {
            let normalized: Vec<Value> = disabled_aliases
                .iter()
                .filter_map(|entry| entry.as_str())
                .map(|entry| entry.trim().to_string())
                .filter(|entry| !entry.is_empty())
                .map(Value::String)
                .collect();
            if !normalized.is_empty() {
                out.insert(
                    "disabledProviderKeyAliases".to_string(),
                    Value::Array(normalized),
                );
            }
        }
    }

    Ok(Value::Object(out))
}
