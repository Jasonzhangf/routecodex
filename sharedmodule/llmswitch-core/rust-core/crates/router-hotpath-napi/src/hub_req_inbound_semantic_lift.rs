use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Debug, Serialize)]
struct ResumeToolOutput {
    #[serde(rename = "tool_call_id")]
    tool_call_id: String,
    content: String,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ReqInboundSemanticLiftInput {
    payload: Option<Value>,
    protocol: Option<String>,
    entry_endpoint: Option<String>,
    responses_resume: Option<Value>,
    #[serde(default)]
    has_client_tools_raw: bool,
    #[serde(default)]
    has_tool_alias_map: bool,
    #[serde(default)]
    has_responses_resume: bool,
    #[serde(default)]
    has_direct_tool_outputs: bool,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ReqInboundSemanticLiftApplyInput {
    chat_envelope: Value,
    payload: Option<Value>,
    protocol: Option<String>,
    entry_endpoint: Option<String>,
    responses_resume: Option<Value>,
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct ReqInboundSemanticLiftOutput {
    #[serde(skip_serializing_if = "Option::is_none")]
    client_tools_raw: Option<Vec<Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_name_alias_map: Option<Map<String, Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    responses_resume: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    mapped_tool_outputs: Option<Vec<ResumeToolOutput>>,
}

fn read_trimmed_string(value: Option<&Value>) -> Option<String> {
    let raw = value
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if raw.is_empty() {
        return None;
    }
    Some(raw)
}

fn normalize_output_text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Null) | None => "\"\"".to_string(),
        Some(other) => {
            serde_json::to_string(other).unwrap_or_else(|_| "[object Object]".to_string())
        }
    }
}

fn map_resume_tool_outputs_detailed(responses_resume: &Value) -> Vec<ResumeToolOutput> {
    let detailed = responses_resume
        .as_object()
        .and_then(|obj| obj.get("toolOutputsDetailed"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    if detailed.is_empty() {
        return Vec::new();
    }

    let mut mapped: Vec<ResumeToolOutput> = Vec::new();
    for (index, entry) in detailed.iter().enumerate() {
        let row = match entry.as_object() {
            Some(v) => v,
            None => continue,
        };
        let call_id = read_trimmed_string(row.get("callId"))
            .or_else(|| read_trimmed_string(row.get("originalId")))
            .unwrap_or(format!("resume_tool_{}", index + 1));

        mapped.push(ResumeToolOutput {
            tool_call_id: call_id,
            content: normalize_output_text(row.get("outputText")),
        });
    }

    mapped
}

fn normalize_anthropic_tool_name(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("mcp__") {
        return Some(lower);
    }
    Some(lower)
}

fn read_name(entry: &Value) -> Option<String> {
    let obj = entry.as_object()?;
    let raw = obj.get("name")?.as_str()?.trim().to_string();
    if raw.is_empty() {
        return None;
    }
    Some(raw)
}

fn build_anthropic_tool_alias_map(raw_tools: &[Value]) -> Option<Map<String, Value>> {
    if raw_tools.is_empty() {
        return None;
    }

    let mut alias_map: Map<String, Value> = Map::new();
    for entry in raw_tools {
        let raw_name = match read_name(entry) {
            Some(v) => v,
            None => continue,
        };
        let normalized =
            normalize_anthropic_tool_name(raw_name.as_str()).unwrap_or(raw_name.clone());
        let canonical_key = normalized.trim().to_string();
        if canonical_key.is_empty() {
            continue;
        }

        alias_map.insert(canonical_key.clone(), Value::String(raw_name.clone()));
        let lower_key = canonical_key.to_ascii_lowercase();
        if lower_key != canonical_key && !alias_map.contains_key(lower_key.as_str()) {
            alias_map.insert(lower_key, Value::String(raw_name));
        }
    }

    if alias_map.is_empty() {
        return None;
    }
    Some(alias_map)
}

fn read_raw_tools(payload: Option<&Value>) -> Vec<Value> {
    payload
        .and_then(|v| v.as_object())
        .and_then(|obj| obj.get("tools"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default()
}

fn should_capture_alias_map(protocol: Option<&str>, entry_endpoint: Option<&str>) -> bool {
    let protocol_value = protocol.unwrap_or("").trim().to_ascii_lowercase();
    if protocol_value == "anthropic-messages" {
        return true;
    }
    let endpoint = entry_endpoint.unwrap_or("").trim().to_ascii_lowercase();
    endpoint.contains("/v1/messages")
}

fn resolve_req_inbound_semantic_lift_plan(
    input: &ReqInboundSemanticLiftInput,
) -> ReqInboundSemanticLiftOutput {
    let mut output = ReqInboundSemanticLiftOutput::default();
    let raw_tools = read_raw_tools(input.payload.as_ref());

    if !input.has_client_tools_raw && !raw_tools.is_empty() {
        output.client_tools_raw = Some(raw_tools.clone());
    }

    if !input.has_tool_alias_map
        && !raw_tools.is_empty()
        && should_capture_alias_map(input.protocol.as_deref(), input.entry_endpoint.as_deref())
    {
        output.tool_name_alias_map = build_anthropic_tool_alias_map(raw_tools.as_slice());
    }

    let responses_resume = input.responses_resume.as_ref().and_then(|value| {
        if value.is_object() {
            Some(value.clone())
        } else {
            None
        }
    });

    if let Some(resume) = responses_resume {
        if !input.has_responses_resume {
            output.responses_resume = Some(resume.clone());
        }
        if !input.has_direct_tool_outputs {
            let mapped = map_resume_tool_outputs_detailed(&resume);
            if !mapped.is_empty() {
                output.mapped_tool_outputs = Some(mapped);
            }
        }
    }

    output
}

fn ensure_object(value: &mut Value) -> &mut Map<String, Value> {
    if !value.is_object() {
        *value = Value::Object(Map::new());
    }
    value.as_object_mut().expect("object just initialized")
}

fn apply_req_inbound_semantic_lift(input: ReqInboundSemanticLiftApplyInput) -> Value {
    let mut chat_envelope = input.chat_envelope;
    let has_direct_tool_outputs = ensure_object(&mut chat_envelope)
        .get("toolOutputs")
        .and_then(|v| v.as_array())
        .map(|v| !v.is_empty())
        .unwrap_or(false);

    let (has_client_tools_raw, has_tool_alias_map, has_responses_resume) = {
        let envelope = ensure_object(&mut chat_envelope);
        let semantics_value = envelope
            .entry("semantics".to_string())
            .or_insert_with(|| Value::Object(Map::new()));
        let semantics = ensure_object(semantics_value);

        let tools_value = semantics
            .entry("tools".to_string())
            .or_insert_with(|| Value::Object(Map::new()));
        let tools = ensure_object(tools_value);

        let has_tool_alias_map = tools
            .get("toolNameAliasMap")
            .and_then(|v| v.as_object())
            .is_some()
            || tools
                .get("toolAliasMap")
                .and_then(|v| v.as_object())
                .is_some();
        let has_client_tools_raw = tools.contains_key("clientToolsRaw");
        let has_responses_resume = semantics
            .get("responses")
            .and_then(|v| v.as_object())
            .map(|responses| responses.contains_key("resume"))
            .unwrap_or(false);
        (
            has_client_tools_raw,
            has_tool_alias_map,
            has_responses_resume,
        )
    };

    let normalized_responses_resume = input.responses_resume.as_ref().and_then(|value| {
        if value.is_object() {
            Some(value.clone())
        } else {
            None
        }
    });

    let plan = resolve_req_inbound_semantic_lift_plan(&ReqInboundSemanticLiftInput {
        payload: input.payload,
        protocol: input.protocol,
        entry_endpoint: input.entry_endpoint,
        responses_resume: normalized_responses_resume.clone(),
        has_client_tools_raw,
        has_tool_alias_map,
        has_responses_resume,
        has_direct_tool_outputs,
    });

    let ReqInboundSemanticLiftOutput {
        client_tools_raw,
        tool_name_alias_map,
        responses_resume,
        mapped_tool_outputs,
    } = plan;

    {
        let envelope = ensure_object(&mut chat_envelope);
        let semantics_value = envelope
            .entry("semantics".to_string())
            .or_insert_with(|| Value::Object(Map::new()));
        let semantics = ensure_object(semantics_value);
        let tools_value = semantics
            .entry("tools".to_string())
            .or_insert_with(|| Value::Object(Map::new()));
        let tools = ensure_object(tools_value);

        if !has_client_tools_raw {
            if let Some(client_tools_raw) = client_tools_raw {
                tools.insert("clientToolsRaw".to_string(), Value::Array(client_tools_raw));
            }
        }

        if !has_tool_alias_map {
            if let Some(alias_map) = tool_name_alias_map {
                tools.insert("toolNameAliasMap".to_string(), Value::Object(alias_map));
            }
        }

        if !has_responses_resume {
            if let Some(resume) = responses_resume {
                let responses_value = semantics
                    .entry("responses".to_string())
                    .or_insert_with(|| Value::Object(Map::new()));
                let responses = ensure_object(responses_value);
                responses.insert("resume".to_string(), resume);
            }
        }

        if !has_direct_tool_outputs {
            if let Some(resume) = normalized_responses_resume {
                let mapped_outputs = mapped_tool_outputs
                    .unwrap_or_else(|| map_resume_tool_outputs_detailed(&resume));
                if !mapped_outputs.is_empty() {
                    let mapped_value = serde_json::to_value(mapped_outputs)
                        .unwrap_or_else(|_| Value::Array(Vec::new()));
                    envelope.insert("toolOutputs".to_string(), mapped_value);
                }
            }
        }
    }

    chat_envelope
}

#[napi]
pub fn map_resume_tool_outputs_detailed_json(responses_resume_json: String) -> NapiResult<String> {
    let responses_resume: Value = serde_json::from_str(&responses_resume_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = map_resume_tool_outputs_detailed(&responses_resume);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn apply_req_inbound_semantic_lift_json(input_json: String) -> NapiResult<String> {
    let input: ReqInboundSemanticLiftApplyInput =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = apply_req_inbound_semantic_lift(input);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}
