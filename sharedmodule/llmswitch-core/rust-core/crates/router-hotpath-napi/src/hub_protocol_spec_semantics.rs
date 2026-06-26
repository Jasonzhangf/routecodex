use napi::bindgen_prelude::Result as NapiResult;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResolveHubProtocolSpecInput {
    protocol: Option<String>,
    allowlists: HubProtocolAllowlists,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SanitizeProviderOutboundPayloadInput {
    protocol: Option<String>,
    compatibility_profile: Option<String>,
    enforce_layout: Option<bool>,
    payload: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HubProtocolAllowlistsOutput {
    openai_chat_allowed_fields: Vec<String>,
    openai_chat_parameters_wrapper_allow_keys: Vec<String>,
    openai_responses_allowed_fields: Vec<String>,
    openai_responses_parameters_wrapper_allow_keys: Vec<String>,
    anthropic_allowed_fields: Vec<String>,
    anthropic_parameters_wrapper_allow_keys: Vec<String>,
    gemini_allowed_fields: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HubProtocolAllowlists {
    openai_chat_allowed_fields: Vec<String>,
    openai_chat_parameters_wrapper_allow_keys: Vec<String>,
    openai_responses_allowed_fields: Vec<String>,
    openai_responses_parameters_wrapper_allow_keys: Vec<String>,
    anthropic_allowed_fields: Vec<String>,
    anthropic_parameters_wrapper_allow_keys: Vec<String>,
    gemini_allowed_fields: Vec<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProviderOutboundLayoutRule {
    code: String,
    path: String,
    detail: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProviderOutboundWrapperFlattenRule {
    wrapper_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    allow_keys: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    alias_keys: Option<BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    only_if_target_missing: Option<bool>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProviderOutboundPolicySpec {
    enforce_enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    allowed_top_level_keys: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    enforce_allowed_top_level_keys: Option<bool>,
    reserved_key_prefixes: Vec<String>,
    forbid_wrappers: Vec<ProviderOutboundLayoutRule>,
    flatten_wrappers: Vec<ProviderOutboundWrapperFlattenRule>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ToolSurfaceSpec {
    expected_tool_format: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    expected_history_carrier: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProtocolSpecOutput {
    id: String,
    provider_outbound: ProviderOutboundPolicySpec,
    tool_surface: ToolSurfaceSpec,
}

fn build_default_spec(allowlists: &HubProtocolAllowlists) -> ProtocolSpecOutput {
    let mut alias_keys = BTreeMap::new();
    alias_keys.insert("max_output_tokens".to_string(), "max_tokens".to_string());

    ProtocolSpecOutput {
        id: "openai-chat".to_string(),
        provider_outbound: ProviderOutboundPolicySpec {
            enforce_enabled: true,
            allowed_top_level_keys: Some(allowlists.openai_chat_allowed_fields.clone()),
            enforce_allowed_top_level_keys: Some(true),
            forbid_wrappers: vec![
                ProviderOutboundLayoutRule {
                    code: "forbid_wrapper".to_string(),
                    path: "parameters".to_string(),
                    detail: "OpenAI Chat provider payload must not contain a top-level parameters wrapper (expects flattened fields).".to_string(),
                },
                ProviderOutboundLayoutRule {
                    code: "forbid_wrapper".to_string(),
                    path: "request".to_string(),
                    detail: "OpenAI Chat provider payload must not contain a nested request wrapper.".to_string(),
                },
            ],
            reserved_key_prefixes: vec!["__".to_string(), "_".to_string()],
            flatten_wrappers: vec![
                ProviderOutboundWrapperFlattenRule {
                    wrapper_key: "request".to_string(),
                    allow_keys: None,
                    alias_keys: None,
                    only_if_target_missing: Some(true),
                },
                ProviderOutboundWrapperFlattenRule {
                    wrapper_key: "parameters".to_string(),
                    allow_keys: Some(allowlists.openai_chat_parameters_wrapper_allow_keys.clone()),
                    alias_keys: Some(alias_keys),
                    only_if_target_missing: Some(true),
                },
            ],
        },
        tool_surface: ToolSurfaceSpec {
            expected_tool_format: "openai".to_string(),
            expected_history_carrier: Some("messages".to_string()),
        },
    }
}

fn build_openai_responses_spec(allowlists: &HubProtocolAllowlists) -> ProtocolSpecOutput {
    let mut alias_keys = BTreeMap::new();
    alias_keys.insert("max_tokens".to_string(), "max_output_tokens".to_string());

    ProtocolSpecOutput {
        id: "openai-responses".to_string(),
        provider_outbound: ProviderOutboundPolicySpec {
            enforce_enabled: true,
            allowed_top_level_keys: Some(allowlists.openai_responses_allowed_fields.clone()),
            enforce_allowed_top_level_keys: Some(true),
            forbid_wrappers: vec![
                ProviderOutboundLayoutRule {
                    code: "forbid_wrapper".to_string(),
                    path: "parameters".to_string(),
                    detail: "Responses provider payload must not contain a top-level parameters wrapper (expects flattened fields).".to_string(),
                },
                ProviderOutboundLayoutRule {
                    code: "forbid_wrapper".to_string(),
                    path: "request".to_string(),
                    detail: "Responses provider payload must not contain a nested request wrapper.".to_string(),
                },
            ],
            reserved_key_prefixes: vec!["__".to_string(), "_".to_string()],
            flatten_wrappers: vec![
                ProviderOutboundWrapperFlattenRule {
                    wrapper_key: "request".to_string(),
                    allow_keys: None,
                    alias_keys: None,
                    only_if_target_missing: Some(true),
                },
                ProviderOutboundWrapperFlattenRule {
                    wrapper_key: "parameters".to_string(),
                    allow_keys: Some(
                        allowlists
                            .openai_responses_parameters_wrapper_allow_keys
                            .clone(),
                    ),
                    alias_keys: Some(alias_keys),
                    only_if_target_missing: Some(true),
                },
            ],
        },
        tool_surface: ToolSurfaceSpec {
            expected_tool_format: "openai".to_string(),
            expected_history_carrier: Some("input".to_string()),
        },
    }
}

fn build_anthropic_spec(allowlists: &HubProtocolAllowlists) -> ProtocolSpecOutput {
    let mut alias_keys = BTreeMap::new();
    alias_keys.insert("max_output_tokens".to_string(), "max_tokens".to_string());

    ProtocolSpecOutput {
        id: "anthropic-messages".to_string(),
        provider_outbound: ProviderOutboundPolicySpec {
            enforce_enabled: true,
            allowed_top_level_keys: Some(allowlists.anthropic_allowed_fields.clone()),
            enforce_allowed_top_level_keys: Some(true),
            forbid_wrappers: vec![
                ProviderOutboundLayoutRule {
                    code: "forbid_wrapper".to_string(),
                    path: "parameters".to_string(),
                    detail: "Anthropic Messages provider payload must not contain a top-level parameters wrapper.".to_string(),
                },
                ProviderOutboundLayoutRule {
                    code: "forbid_wrapper".to_string(),
                    path: "request".to_string(),
                    detail: "Anthropic Messages provider payload must not contain a nested request wrapper.".to_string(),
                },
            ],
            reserved_key_prefixes: vec!["__".to_string(), "_".to_string()],
            flatten_wrappers: vec![
                ProviderOutboundWrapperFlattenRule {
                    wrapper_key: "request".to_string(),
                    allow_keys: None,
                    alias_keys: None,
                    only_if_target_missing: Some(true),
                },
                ProviderOutboundWrapperFlattenRule {
                    wrapper_key: "parameters".to_string(),
                    allow_keys: Some(allowlists.anthropic_parameters_wrapper_allow_keys.clone()),
                    alias_keys: Some(alias_keys),
                    only_if_target_missing: Some(true),
                },
            ],
        },
        tool_surface: ToolSurfaceSpec {
            expected_tool_format: "anthropic".to_string(),
            expected_history_carrier: None,
        },
    }
}

fn build_gemini_spec(allowlists: &HubProtocolAllowlists) -> ProtocolSpecOutput {
    ProtocolSpecOutput {
        id: "gemini-chat".to_string(),
        provider_outbound: ProviderOutboundPolicySpec {
            enforce_enabled: true,
            allowed_top_level_keys: Some(allowlists.gemini_allowed_fields.clone()),
            enforce_allowed_top_level_keys: Some(true),
            forbid_wrappers: vec![
                ProviderOutboundLayoutRule {
                    code: "forbid_wrapper".to_string(),
                    path: "parameters".to_string(),
                    detail:
                        "Gemini provider payload must not contain a top-level parameters wrapper."
                            .to_string(),
                },
                ProviderOutboundLayoutRule {
                    code: "forbid_wrapper".to_string(),
                    path: "request".to_string(),
                    detail: "Gemini provider payload must not contain a nested request wrapper."
                        .to_string(),
                },
            ],
            reserved_key_prefixes: vec!["__".to_string(), "_".to_string()],
            flatten_wrappers: vec![ProviderOutboundWrapperFlattenRule {
                wrapper_key: "request".to_string(),
                allow_keys: None,
                alias_keys: None,
                only_if_target_missing: Some(true),
            }],
        },
        tool_surface: ToolSurfaceSpec {
            expected_tool_format: "gemini".to_string(),
            expected_history_carrier: None,
        },
    }
}

fn resolve_hub_protocol_spec(input: ResolveHubProtocolSpecInput) -> ProtocolSpecOutput {
    let normalized = input
        .protocol
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    match normalized.as_str() {
        "openai-responses" => build_openai_responses_spec(&input.allowlists),
        "anthropic-messages" => build_anthropic_spec(&input.allowlists),
        "gemini-chat" => build_gemini_spec(&input.allowlists),
        _ => build_default_spec(&input.allowlists),
    }
}

fn normalize_provider_protocol(protocol: Option<&str>) -> String {
    match protocol
        .unwrap_or("openai-chat")
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "responses" | "openai-responses" => "openai-responses".to_string(),
        "anthropic" | "anthropic-messages" => "anthropic-messages".to_string(),
        "gemini" | "gemini-chat" => "gemini-chat".to_string(),
        _ => "openai-chat".to_string(),
    }
}

fn is_gemini_agent_payload(payload: &Map<String, Value>) -> bool {
    if matches!(payload.get("project"), Some(Value::String(_)))
        || matches!(payload.get("requestType"), Some(Value::String(_)))
        || matches!(payload.get("userAgent"), Some(Value::String(_)))
        || matches!(payload.get("requestId"), Some(Value::String(_)))
    {
        return true;
    }
    match payload.get("request") {
        Some(Value::Object(request)) => {
            request.contains_key("contents")
                || request.contains_key("systemInstruction")
                || request.contains_key("tools")
                || request.contains_key("toolConfig")
                || request.contains_key("generationConfig")
                || request.contains_key("safetySettings")
        }
        _ => false,
    }
}

fn strip_responses_reasoning_content(payload: &mut Map<String, Value>) {
    let Some(Value::Array(input)) = payload.get_mut("input") else {
        return;
    };
    for item in input.iter_mut() {
        let Value::Object(row) = item else {
            continue;
        };
        if matches!(row.get("type"), Some(Value::String(kind)) if kind == "reasoning") {
            row.remove("content");
            row.remove("encrypted_content");
        }
    }
}

fn assert_no_namespace_tool_aggregate(value: &Value, path: &str) -> Result<(), String> {
    match value {
        Value::Object(object) => {
            let item_type = object
                .get("type")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or("");
            if item_type.eq_ignore_ascii_case("namespace") {
                return Err(format!(
                    "provider outbound payload must not carry namespace tool aggregate at {path}"
                ));
            }
            if object.contains_key("tools")
                && object.get("tools").is_some_and(Value::is_array)
                && object.get("name").and_then(Value::as_str).is_some()
                && !object.contains_key("function")
            {
                return Err(format!(
                    "provider outbound payload must not carry namespace tool aggregate at {path}"
                ));
            }
            for (key, child) in object {
                let child_path = if path == "$" {
                    format!("$.{key}")
                } else {
                    format!("{path}.{key}")
                };
                assert_no_namespace_tool_aggregate(child, child_path.as_str())?;
            }
        }
        Value::Array(items) => {
            for (index, child) in items.iter().enumerate() {
                assert_no_namespace_tool_aggregate(child, format!("{path}[{index}]").as_str())?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn build_provider_outbound_function_tool(
    protocol: &str,
    name: &str,
    description: Option<Value>,
    parameters: Option<Value>,
    strict: Option<Value>,
) -> Value {
    let mut function = Map::new();
    function.insert("name".to_string(), Value::String(name.to_string()));
    if let Some(description) = description {
        function.insert("description".to_string(), description);
    }
    if let Some(parameters) = parameters {
        function.insert("parameters".to_string(), parameters);
    }
    if let Some(strict) = strict {
        function.insert("strict".to_string(), strict);
    }

    let mut out = Map::new();
    out.insert("type".to_string(), Value::String("function".to_string()));
    if protocol == "openai-responses" {
        for (key, value) in function {
            out.insert(key, value);
        }
    } else {
        out.insert("function".to_string(), Value::Object(function));
    }
    Value::Object(out)
}

fn normalize_provider_outbound_tool(protocol: &str, tool: &Value) -> Vec<Value> {
    let Some(row) = tool.as_object() else {
        return vec![tool.clone()];
    };
    let tool_type = row
        .get("type")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    if tool_type.eq_ignore_ascii_case("custom") {
        let name = row
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty());
        if matches!(name, Some("apply_patch")) {
            if protocol == "openai-responses" {
                return vec![tool.clone()];
            }
            let description = row
                .get("description")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| Value::String(value.to_string()));
            let parameters = serde_json::json!({
                "type": "object",
                "properties": {
                    "patch": {
                        "type": "string",
                        "description": "Raw apply_patch text. Send canonical *** Begin Patch / *** End Patch grammar as a single string. Put workspace-relative paths inside patch headers such as *** Add File: tmp/example.txt or *** Update File: src/main.ts. For temporary tests, use tmp/... inside the workspace, not /tmp/.... Do not use absolute paths."
                    }
                },
                "required": ["patch"],
                "additionalProperties": true
            });
            return vec![build_provider_outbound_function_tool(
                protocol,
                "apply_patch",
                description,
                Some(parameters),
                Some(Value::Bool(false)),
            )];
        }
    }
    if tool_type.eq_ignore_ascii_case("function") {
        let function_row = row
            .get("function")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let name = row
            .get("name")
            .and_then(Value::as_str)
            .or_else(|| function_row.get("name").and_then(Value::as_str))
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let Some(name) = name else {
            return vec![tool.clone()];
        };

        let description = row
            .get("description")
            .and_then(Value::as_str)
            .or_else(|| function_row.get("description").and_then(Value::as_str))
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| Value::String(value.to_string()));
        let parameters = row
            .get("parameters")
            .or_else(|| function_row.get("parameters"))
            .cloned();
        let strict = row
            .get("strict")
            .or_else(|| function_row.get("strict"))
            .cloned();

        return vec![build_provider_outbound_function_tool(
            protocol,
            name,
            description,
            parameters,
            strict,
        )];
    }
    if !tool_type.eq_ignore_ascii_case("namespace") {
        return vec![tool.clone()];
    }

    let Some(children) = row.get("tools").and_then(Value::as_array) else {
        return vec![tool.clone()];
    };

    children
        .iter()
        .filter_map(|child| {
            let child_row = child.as_object()?;
            let child_function = child_row.get("function").and_then(Value::as_object);
            let name = child_function
                .and_then(|function| function.get("name"))
                .or_else(|| child_row.get("name"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())?;

            let description = child_function
                .and_then(|function| function.get("description"))
                .or_else(|| child_row.get("description"))
                .cloned();
            let parameters = child_function
                .and_then(|function| function.get("parameters"))
                .or_else(|| child_row.get("parameters"))
                .cloned();
            let strict = child_function
                .and_then(|function| function.get("strict"))
                .or_else(|| child_row.get("strict"))
                .cloned();

            Some(build_provider_outbound_function_tool(
                protocol,
                name,
                description,
                parameters,
                strict,
            ))
        })
        .collect()
}

fn normalize_provider_outbound_tools(protocol: &str, payload: &mut Map<String, Value>) {
    if protocol != "openai-chat" && protocol != "openai-responses" {
        return;
    }
    let Some(Value::Array(tools)) = payload.get_mut("tools") else {
        return;
    };
    let normalized = tools
        .iter()
        .flat_map(|tool| normalize_provider_outbound_tool(protocol, tool))
        .collect::<Vec<Value>>();
    *tools = normalized;
}

fn normalize_openai_responses_content_part(part: &mut Value) {
    let Some(row) = part.as_object_mut() else {
        return;
    };
    let part_type = row
        .get("type")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    if part_type.eq_ignore_ascii_case("image_url") {
        row.insert("type".to_string(), Value::String("input_image".to_string()));
    }
    if row.get("type").and_then(Value::as_str) == Some("input_image") {
        if let Some(url) = row
            .get("image_url")
            .and_then(Value::as_object)
            .and_then(|image_url| image_url.get("url"))
            .and_then(Value::as_str)
            .map(str::to_string)
        {
            row.insert("image_url".to_string(), Value::String(url));
        }
    }
}

fn normalize_openai_responses_input_items(payload: &mut Map<String, Value>) {
    let Some(Value::Array(input_items)) = payload.get_mut("input") else {
        return;
    };
    for item in input_items.iter_mut() {
        let Some(row) = item.as_object_mut() else {
            continue;
        };
        let Some(Value::Array(content)) = row.get_mut("content") else {
            continue;
        };
        for part in content.iter_mut() {
            normalize_openai_responses_content_part(part);
        }
    }
}

fn default_allowlists_for_input() -> HubProtocolAllowlists {
    let allowlists = build_default_allowlists();
    HubProtocolAllowlists {
        openai_chat_allowed_fields: allowlists.openai_chat_allowed_fields,
        openai_chat_parameters_wrapper_allow_keys: allowlists
            .openai_chat_parameters_wrapper_allow_keys,
        openai_responses_allowed_fields: allowlists.openai_responses_allowed_fields,
        openai_responses_parameters_wrapper_allow_keys: allowlists
            .openai_responses_parameters_wrapper_allow_keys,
        anthropic_allowed_fields: allowlists.anthropic_allowed_fields,
        anthropic_parameters_wrapper_allow_keys: allowlists.anthropic_parameters_wrapper_allow_keys,
        gemini_allowed_fields: allowlists.gemini_allowed_fields,
    }
}

fn apply_provider_outbound_policy(
    protocol: &str,
    compatibility_profile: Option<&str>,
    mut payload: Map<String, Value>,
) -> Map<String, Value> {
    let spec = resolve_hub_protocol_spec(ResolveHubProtocolSpecInput {
        protocol: Some(protocol.to_string()),
        allowlists: default_allowlists_for_input(),
    });

    if protocol == "openai-responses"
        && !compatibility_profile
            .unwrap_or("")
            .to_ascii_lowercase()
            .contains("deepseek")
    {
        strip_responses_reasoning_content(&mut payload);
    }

    normalize_provider_outbound_tools(protocol, &mut payload);
    if protocol == "openai-responses" {
        normalize_openai_responses_input_items(&mut payload);
    }

    if !spec.provider_outbound.enforce_enabled {
        return payload;
    }

    let reserved_prefixes = spec.provider_outbound.reserved_key_prefixes;
    payload.retain(|key, _| {
        !reserved_prefixes
            .iter()
            .any(|prefix| key.starts_with(prefix))
    });

    let is_gemini_envelope = protocol == "gemini-chat" && is_gemini_agent_payload(&payload);
    for rule in spec.provider_outbound.flatten_wrappers {
        if rule.wrapper_key.is_empty() || (is_gemini_envelope && rule.wrapper_key == "request") {
            continue;
        }
        let Some(Value::Object(mut inner)) = payload.get(&rule.wrapper_key).cloned() else {
            continue;
        };
        if let Some(alias_keys) = rule.alias_keys {
            for (from, to) in alias_keys {
                if !inner.contains_key(&to) {
                    if let Some(value) = inner.get(&from).cloned() {
                        inner.insert(to, value);
                    }
                }
            }
        }
        let allow_keys = rule
            .allow_keys
            .map(|keys| keys.into_iter().collect::<BTreeSet<String>>());
        let only_if_missing = rule.only_if_target_missing.unwrap_or(true);
        for (key, value) in inner {
            if allow_keys
                .as_ref()
                .is_some_and(|allowed| !allowed.contains(&key))
            {
                continue;
            }
            if !only_if_missing || !payload.contains_key(&key) {
                payload.insert(key, value);
            }
        }
        payload.remove(&rule.wrapper_key);
    }

    if spec
        .provider_outbound
        .enforce_allowed_top_level_keys
        .unwrap_or(false)
    {
        if let Some(keys) = spec.provider_outbound.allowed_top_level_keys {
            let mut allowed = keys.into_iter().collect::<BTreeSet<String>>();
            if is_gemini_envelope {
                allowed.extend([
                    "request".to_string(),
                    "project".to_string(),
                    "requestId".to_string(),
                    "requestType".to_string(),
                    "userAgent".to_string(),
                    "action".to_string(),
                ]);
            }
            payload.retain(|key, _| allowed.contains(key));
        }
    }

    payload
}

fn build_default_allowlists() -> HubProtocolAllowlistsOutput {
    HubProtocolAllowlistsOutput {
        openai_chat_allowed_fields: vec![
            "messages".to_string(),
            "tools".to_string(),
            "tool_outputs".to_string(),
            "model".to_string(),
            "temperature".to_string(),
            "top_p".to_string(),
            "top_k".to_string(),
            "max_tokens".to_string(),
            "frequency_penalty".to_string(),
            "presence_penalty".to_string(),
            "logit_bias".to_string(),
            "response_format".to_string(),
            "parallel_tool_calls".to_string(),
            "tool_choice".to_string(),
            "seed".to_string(),
            "user".to_string(),
            "metadata".to_string(),
            "stop".to_string(),
            "stop_sequences".to_string(),
            "stream".to_string(),
            "stream_options".to_string(),
            "thinking".to_string(),
            "reasoning".to_string(),
        ],
        anthropic_allowed_fields: vec![
            "model".to_string(),
            "messages".to_string(),
            "tools".to_string(),
            "system".to_string(),
            "stop_sequences".to_string(),
            "temperature".to_string(),
            "top_p".to_string(),
            "top_k".to_string(),
            "max_tokens".to_string(),
            "max_output_tokens".to_string(),
            "thinking".to_string(),
            "output_config".to_string(),
            "metadata".to_string(),
            "stream".to_string(),
            "tool_choice".to_string(),
        ],
        openai_responses_allowed_fields: vec![
            "id".to_string(),
            "object".to_string(),
            "created_at".to_string(),
            "model".to_string(),
            "status".to_string(),
            "input".to_string(),
            "instructions".to_string(),
            "output".to_string(),
            "output_text".to_string(),
            "required_action".to_string(),
            "response_id".to_string(),
            "previous_response_id".to_string(),
            "tool_outputs".to_string(),
            "tools".to_string(),
            "metadata".to_string(),
            "include".to_string(),
            "store".to_string(),
            "user".to_string(),
            "response_format".to_string(),
            "temperature".to_string(),
            "top_p".to_string(),
            "top_k".to_string(),
            "max_tokens".to_string(),
            "max_output_tokens".to_string(),
            "logit_bias".to_string(),
            "seed".to_string(),
            "parallel_tool_calls".to_string(),
            "tool_choice".to_string(),
            "prompt_cache_key".to_string(),
            "reasoning".to_string(),
            "stream".to_string(),
            "instructions_is_raw".to_string(),
        ],
        gemini_allowed_fields: vec![
            "model".to_string(),
            "contents".to_string(),
            "systemInstruction".to_string(),
            "system_instruction".to_string(),
            "generationConfig".to_string(),
            "generation_config".to_string(),
            "safetySettings".to_string(),
            "safety_settings".to_string(),
            "metadata".to_string(),
            "toolConfig".to_string(),
            "tool_config".to_string(),
            "tools".to_string(),
            "tool_choice".to_string(),
            "parallelToolCalls".to_string(),
            "parallel_tool_calls".to_string(),
            "responseMimeType".to_string(),
            "response_mime_type".to_string(),
            "stopSequences".to_string(),
            "stop_sequences".to_string(),
            "cachedContent".to_string(),
            "prompt".to_string(),
            "response".to_string(),
            "candidates".to_string(),
            "usageMetadata".to_string(),
            "responseMetadata".to_string(),
            "promptFeedback".to_string(),
            "modelVersion".to_string(),
            "client".to_string(),
            "user".to_string(),
            "stream".to_string(),
        ],
        openai_responses_parameters_wrapper_allow_keys: vec![
            "temperature".to_string(),
            "top_p".to_string(),
            "max_output_tokens".to_string(),
            "seed".to_string(),
            "logit_bias".to_string(),
            "user".to_string(),
            "parallel_tool_calls".to_string(),
            "tool_choice".to_string(),
            "response_format".to_string(),
            "prompt_cache_key".to_string(),
            "reasoning".to_string(),
            "stream".to_string(),
            "stop".to_string(),
            "stop_sequences".to_string(),
            "modalities".to_string(),
            "top_k".to_string(),
        ],
        openai_chat_parameters_wrapper_allow_keys: vec![
            "temperature".to_string(),
            "top_p".to_string(),
            "top_k".to_string(),
            "max_tokens".to_string(),
            "frequency_penalty".to_string(),
            "presence_penalty".to_string(),
            "logit_bias".to_string(),
            "seed".to_string(),
            "user".to_string(),
            "parallel_tool_calls".to_string(),
            "tool_choice".to_string(),
            "response_format".to_string(),
            "stream".to_string(),
            "stop".to_string(),
            "stop_sequences".to_string(),
            "thinking".to_string(),
            "reasoning".to_string(),
        ],
        anthropic_parameters_wrapper_allow_keys: vec![
            "stop_sequences".to_string(),
            "temperature".to_string(),
            "top_p".to_string(),
            "top_k".to_string(),
            "max_tokens".to_string(),
            "max_output_tokens".to_string(),
            "metadata".to_string(),
            "stream".to_string(),
            "tool_choice".to_string(),
        ],
    }
}

#[napi_derive::napi]
pub fn sanitize_provider_outbound_payload_json(input_json: String) -> NapiResult<String> {
    let input: SanitizeProviderOutboundPayloadInput =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let mut payload = match input.payload {
        Value::Object(row) => row,
        _ => {
            return Err(napi::Error::from_reason(
                "provider outbound payload must be an object".to_string(),
            ))
        }
    };
    let protocol = normalize_provider_protocol(input.protocol.as_deref());
    if input.enforce_layout == Some(false) {
        normalize_provider_outbound_tools(&protocol, &mut payload);
        if protocol == "openai-responses"
            && !input
                .compatibility_profile
                .as_deref()
                .unwrap_or("")
                .to_ascii_lowercase()
                .contains("deepseek")
        {
            strip_responses_reasoning_content(&mut payload);
        }
        assert_no_namespace_tool_aggregate(&Value::Object(payload.clone()), "$")
            .map_err(napi::Error::from_reason)?;
        return serde_json::to_string(&Value::Object(payload))
            .map_err(|e| napi::Error::from_reason(e.to_string()));
    }
    let output =
        apply_provider_outbound_policy(&protocol, input.compatibility_profile.as_deref(), payload);
    assert_no_namespace_tool_aggregate(&Value::Object(output.clone()), "$")
        .map_err(napi::Error::from_reason)?;
    serde_json::to_string(&Value::Object(output))
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_allowlists_include_required_keys() {
        let allowlists = build_default_allowlists();
        assert!(allowlists
            .openai_chat_allowed_fields
            .contains(&"messages".to_string()));
        assert!(allowlists
            .openai_responses_allowed_fields
            .contains(&"input".to_string()));
        assert!(allowlists
            .anthropic_allowed_fields
            .contains(&"messages".to_string()));
        assert!(allowlists
            .gemini_allowed_fields
            .contains(&"contents".to_string()));
    }

    #[test]
    fn resolve_hub_protocol_spec_defaults_to_openai_chat() {
        let allowlists = build_default_allowlists();
        let input = ResolveHubProtocolSpecInput {
            protocol: Some("unknown-protocol".to_string()),
            allowlists: HubProtocolAllowlists {
                openai_chat_allowed_fields: allowlists.openai_chat_allowed_fields,
                openai_chat_parameters_wrapper_allow_keys: allowlists
                    .openai_chat_parameters_wrapper_allow_keys,
                openai_responses_allowed_fields: allowlists.openai_responses_allowed_fields,
                openai_responses_parameters_wrapper_allow_keys: allowlists
                    .openai_responses_parameters_wrapper_allow_keys,
                anthropic_allowed_fields: allowlists.anthropic_allowed_fields,
                anthropic_parameters_wrapper_allow_keys: allowlists
                    .anthropic_parameters_wrapper_allow_keys,
                gemini_allowed_fields: allowlists.gemini_allowed_fields,
            },
        };

        let spec = resolve_hub_protocol_spec(input);
        assert_eq!(spec.id, "openai-chat");
        assert_eq!(spec.tool_surface.expected_tool_format, "openai");
    }

    #[test]
    fn sanitize_provider_outbound_payload_strips_responses_reasoning_content() {
        let payload = serde_json::json!({
            "model": "gpt-5.5",
            "input": [{
                "type": "reasoning",
                "content": [{"type":"reasoning_text","text":"private"}],
                "summary": [{"type":"summary_text","text":"summary"}],
                "encrypted_content": null
            }],
            "parameters": {"max_tokens": 128},
            "__private": true,
            "unknown": true
        });
        let Value::Object(payload) = payload else {
            panic!("object payload expected");
        };
        let output = apply_provider_outbound_policy("openai-responses", None, payload);
        assert!(!output.contains_key("__private"));
        assert!(!output.contains_key("unknown"));
        assert_eq!(
            output.get("max_output_tokens"),
            Some(&serde_json::json!(128))
        );
        let input_items = output.get("input").and_then(Value::as_array).unwrap();
        let reasoning = input_items[0].as_object().unwrap();
        assert!(!reasoning.contains_key("content"));
        assert!(!reasoning.contains_key("encrypted_content"));
        assert!(reasoning.contains_key("summary"));
    }

    #[test]
    fn sanitize_provider_outbound_payload_preserves_deepseek_reasoning_content() {
        let payload = serde_json::json!({
            "model": "deepseek-reasoner",
            "input": [{
                "type": "reasoning",
                "content": [{"type":"reasoning_text","text":"keep"}]
            }]
        });
        let Value::Object(payload) = payload else {
            panic!("object payload expected");
        };
        let output =
            apply_provider_outbound_policy("openai-responses", Some("chat:deepseek"), payload);
        let input_items = output.get("input").and_then(Value::as_array).unwrap();
        let reasoning = input_items[0].as_object().unwrap();
        assert!(reasoning.contains_key("content"));
    }

    #[test]
    fn sanitize_provider_outbound_payload_normalizes_responses_image_url_parts() {
        let payload = serde_json::json!({
            "model": "gpt-5.5",
            "input": [{
                "type": "message",
                "role": "user",
                "content": [
                    { "type": "input_text", "text": "<image name=[Image #1]>" },
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": "data:image/png;base64,AAA",
                            "detail": "high"
                        }
                    },
                    { "type": "input_text", "text": "[Image #1]" }
                ]
            }]
        });
        let Value::Object(payload) = payload else {
            panic!("object payload expected");
        };
        let output = apply_provider_outbound_policy("openai-responses", None, payload);
        let input_items = output.get("input").and_then(Value::as_array).unwrap();
        let content = input_items[0]
            .get("content")
            .and_then(Value::as_array)
            .unwrap();
        assert_eq!(content[1]["type"], serde_json::json!("input_image"));
        assert_eq!(
            content[1]["image_url"],
            serde_json::json!("data:image/png;base64,AAA")
        );
    }

    #[test]
    fn sanitize_provider_outbound_payload_flattens_namespace_tool_aggregate() {
        let input = serde_json::json!({
            "protocol": "openai-responses",
            "payload": {
                "model": "minimax-m3-free",
                "input": [{"role": "user", "content": [{"type": "input_text", "text": "hi"}]}],
                "tools": [{"type": "namespace", "name": "multi_agent_v1", "tools": [{"type":"function", "name":"spawn_agent", "description":"spawn", "parameters":{"type":"object"}}]}]
            }
        });

        let output: Value = serde_json::from_str(
            &sanitize_provider_outbound_payload_json(input.to_string()).unwrap(),
        )
        .unwrap();
        let tools = output["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["type"], serde_json::json!("function"));
        assert_eq!(tools[0]["name"], serde_json::json!("spawn_agent"));
        assert_eq!(tools[0]["description"], serde_json::json!("spawn"));
        assert_eq!(tools[0]["parameters"], serde_json::json!({"type":"object"}));
        assert!(tools[0].get("function").is_none());
    }

    #[test]
    fn sanitize_provider_outbound_payload_keeps_responses_function_tools_flat() {
        let input = serde_json::json!({
            "protocol": "openai-responses",
            "payload": {
                "model": "gpt-5.5",
                "tools": [{
                    "type": "function",
                    "function": {
                        "name": "apply_patch",
                        "description": "Edit files through apply_patch",
                        "parameters": { "type": "object", "properties": { "patch": { "type": "string" } } },
                        "strict": false
                    }
                }],
                "input": [{ "role": "user", "content": [{ "type": "input_text", "text": "patch" }] }]
            }
        });

        let output: Value = serde_json::from_str(
            &sanitize_provider_outbound_payload_json(input.to_string()).unwrap(),
        )
        .unwrap();
        let tools = output["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["type"], serde_json::json!("function"));
        assert_eq!(tools[0]["name"], serde_json::json!("apply_patch"));
        assert_eq!(
            tools[0]["description"],
            serde_json::json!("Edit files through apply_patch")
        );
        assert_eq!(
            tools[0]["parameters"],
            serde_json::json!({ "type": "object", "properties": { "patch": { "type": "string" } } })
        );
        assert_eq!(tools[0]["strict"], serde_json::json!(false));
        assert!(tools[0].get("function").is_none());
    }

    #[test]
    fn sanitize_provider_outbound_payload_preserves_custom_apply_patch_for_openai_responses() {
        let input = serde_json::json!({
            "protocol": "openai-responses",
            "payload": {
                "model": "gpt-5.5",
                "tools": [{
                    "type": "custom",
                    "name": "apply_patch",
                    "description": "Use the `apply_patch` tool to edit files.",
                    "format": {
                        "type": "grammar",
                        "syntax": "lark",
                        "definition": "start: begin_patch\\nbegin_patch: \\\"*** Begin Patch\\\""
                    }
                }],
                "input": [{ "role": "user", "content": [{ "type": "input_text", "text": "patch" }] }]
            }
        });

        let output: Value = serde_json::from_str(
            &sanitize_provider_outbound_payload_json(input.to_string()).unwrap(),
        )
        .unwrap();
        let tools = output["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["type"], serde_json::json!("custom"));
        assert_eq!(tools[0]["name"], serde_json::json!("apply_patch"));
        assert_eq!(
            tools[0]["description"],
            serde_json::json!("Use the `apply_patch` tool to edit files.")
        );
        assert_eq!(tools[0]["format"]["type"], serde_json::json!("grammar"));
        assert_eq!(tools[0]["format"]["syntax"], serde_json::json!("lark"));
        assert_eq!(
            tools[0]["format"]["definition"],
            serde_json::json!("start: begin_patch\\nbegin_patch: \\\"*** Begin Patch\\\"")
        );
        assert!(tools[0].get("parameters").is_none());
        assert!(tools[0].get("strict").is_none());
        assert!(tools[0].get("function").is_none());
    }

    #[test]
    fn sanitize_provider_outbound_payload_converts_custom_apply_patch_for_openai_chat() {
        let input = serde_json::json!({
            "protocol": "openai-chat",
            "payload": {
                "model": "minimax-m3-free",
                "messages": [{ "role": "user", "content": "patch" }],
                "tools": [{
                    "type": "custom",
                    "name": "apply_patch",
                    "description": "Use the `apply_patch` tool to edit files."
                }]
            }
        });

        let output: Value = serde_json::from_str(
            &sanitize_provider_outbound_payload_json(input.to_string()).unwrap(),
        )
        .unwrap();
        let tools = output["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["type"], serde_json::json!("function"));
        assert_eq!(
            tools[0]["function"]["name"],
            serde_json::json!("apply_patch")
        );
        assert_eq!(
            tools[0]["function"]["description"],
            serde_json::json!("Use the `apply_patch` tool to edit files.")
        );
        assert_eq!(tools[0]["function"]["strict"], serde_json::json!(false));
        assert_eq!(
            tools[0]["function"]["parameters"]["required"],
            serde_json::json!(["patch"])
        );
    }
}
