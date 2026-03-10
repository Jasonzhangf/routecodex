use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GovernRequestInput {
    request: Value,
    protocol: Option<String>,
    registry: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GovernResponseInput {
    payload: Value,
    protocol: Option<String>,
    registry: Option<Value>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct NativeToolGovernanceRule {
    #[serde(default)]
    max_name_length: Option<i64>,
    #[serde(default)]
    allowed_characters: Option<String>,
    #[serde(default)]
    force_case: Option<String>,
    #[serde(default)]
    default_name: Option<String>,
    #[serde(default)]
    trim_whitespace: Option<bool>,
    #[serde(default)]
    on_violation: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct NativeToolGovernanceRuleNode {
    #[serde(default)]
    request: Option<NativeToolGovernanceRule>,
    #[serde(default)]
    response: Option<NativeToolGovernanceRule>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolGovernanceSummary {
    protocol: String,
    direction: String,
    applied: bool,
    sanitized_names: i64,
    truncated_names: i64,
    defaulted_names: i64,
    timestamp: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GovernRequestOutput {
    request: Value,
    summary: ToolGovernanceSummary,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GovernResponseOutput {
    payload: Value,
    summary: ToolGovernanceSummary,
}

#[derive(Debug)]
struct GovernanceStats {
    protocol: String,
    applied: bool,
    sanitized_names: i64,
    truncated_names: i64,
    defaulted_names: i64,
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn normalize_protocol(protocol: Option<&str>) -> String {
    let raw = protocol
        .unwrap_or("openai-chat")
        .trim()
        .to_ascii_lowercase();
    match raw.as_str() {
        "anthropic-messages" => "anthropic".to_string(),
        "gemini-chat" => "gemini".to_string(),
        "responses" | "openai-responses" => "openai-responses".to_string(),
        "openai-chat" | "" => "openai-chat".to_string(),
        _ => raw,
    }
}

fn default_rule(max_len: i64, allowed: &str, force_case: Option<&str>) -> NativeToolGovernanceRule {
    NativeToolGovernanceRule {
        max_name_length: Some(max_len),
        allowed_characters: Some(allowed.to_string()),
        force_case: force_case.map(|v| v.to_string()),
        default_name: Some("tool".to_string()),
        trim_whitespace: Some(true),
        on_violation: Some("truncate".to_string()),
    }
}

fn default_registry() -> std::collections::BTreeMap<String, NativeToolGovernanceRuleNode> {
    let mut out = std::collections::BTreeMap::new();
    out.insert(
        "openai-chat".to_string(),
        NativeToolGovernanceRuleNode {
            request: Some(default_rule(64, "alpha_num", None)),
            response: Some(default_rule(64, "alpha_num", None)),
        },
    );
    out.insert(
        "openai-responses".to_string(),
        NativeToolGovernanceRuleNode {
            request: Some(default_rule(64, "alpha_num", None)),
            response: Some(default_rule(64, "alpha_num", None)),
        },
    );
    out.insert(
        "anthropic".to_string(),
        NativeToolGovernanceRuleNode {
            request: Some(default_rule(64, "lower_snake", Some("lower"))),
            response: Some(default_rule(64, "lower_snake", Some("lower"))),
        },
    );
    out.insert(
        "gemini".to_string(),
        NativeToolGovernanceRuleNode {
            request: Some(default_rule(64, "alpha_num", None)),
            response: Some(default_rule(64, "alpha_num", None)),
        },
    );
    out
}

fn read_string_field(obj: &Map<String, Value>, key: &str) -> Option<String> {
    obj.get(key)
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn read_i64_field(obj: &Map<String, Value>, key: &str) -> Option<i64> {
    obj.get(key).and_then(|v| match v {
        Value::Number(n) => n.as_i64(),
        Value::String(raw) => raw.trim().parse::<i64>().ok(),
        _ => None,
    })
}

fn read_bool_field(obj: &Map<String, Value>, key: &str) -> Option<bool> {
    obj.get(key).and_then(|v| match v {
        Value::Bool(b) => Some(*b),
        Value::String(raw) => {
            let lowered = raw.trim().to_ascii_lowercase();
            if lowered == "true" {
                return Some(true);
            }
            if lowered == "false" {
                return Some(false);
            }
            None
        }
        _ => None,
    })
}

fn parse_native_rule(value: Option<&Value>) -> Option<NativeToolGovernanceRule> {
    let obj = value.and_then(|row| row.as_object())?;
    let mut rule = NativeToolGovernanceRule {
        max_name_length: read_i64_field(obj, "maxNameLength")
            .or_else(|| read_i64_field(obj, "max_name_length")),
        allowed_characters: read_string_field(obj, "allowedCharacters")
            .or_else(|| read_string_field(obj, "allowed_characters")),
        force_case: read_string_field(obj, "forceCase")
            .or_else(|| read_string_field(obj, "force_case")),
        default_name: read_string_field(obj, "defaultName")
            .or_else(|| read_string_field(obj, "default_name")),
        trim_whitespace: read_bool_field(obj, "trimWhitespace")
            .or_else(|| read_bool_field(obj, "trim_whitespace")),
        on_violation: read_string_field(obj, "onViolation")
            .or_else(|| read_string_field(obj, "on_violation")),
    };

    if rule.allowed_characters.is_none() {
        let source = obj
            .get("allowedCharacters")
            .and_then(|v| v.as_object())
            .and_then(|v| v.get("source"))
            .and_then(|v| v.as_str())
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty());
        if source.is_some() {
            rule.allowed_characters = source;
        }
    }

    Some(rule)
}

fn parse_registry_candidate(
    candidate: Option<&Value>,
) -> std::collections::BTreeMap<String, NativeToolGovernanceRuleNode> {
    let mut registry = default_registry();
    let Some(Value::Object(root)) = candidate else {
        return registry;
    };

    for (key, value) in root {
        let protocol = normalize_protocol(Some(key.as_str()));
        if protocol.is_empty() {
            continue;
        }
        let Some(node_obj) = value.as_object() else {
            continue;
        };
        let request = parse_native_rule(node_obj.get("request"));
        let response = parse_native_rule(node_obj.get("response"));
        if request.is_none() && response.is_none() {
            continue;
        }
        registry.insert(protocol, NativeToolGovernanceRuleNode { request, response });
    }

    registry
}

fn resolve_request_rule(
    protocol: &str,
    registry: &std::collections::BTreeMap<String, NativeToolGovernanceRuleNode>,
) -> Option<NativeToolGovernanceRule> {
    if let Some(rule) = registry.get(protocol).and_then(|node| node.request.clone()) {
        return Some(rule);
    }
    registry
        .get("openai-chat")
        .and_then(|node| node.request.clone())
}

fn resolve_response_rule(
    protocol: &str,
    registry: &std::collections::BTreeMap<String, NativeToolGovernanceRuleNode>,
) -> Option<NativeToolGovernanceRule> {
    if let Some(rule) = registry
        .get(protocol)
        .and_then(|node| node.response.clone())
    {
        return Some(rule);
    }
    registry
        .get("openai-chat")
        .and_then(|node| node.response.clone())
}

fn read_default_name(rule: &NativeToolGovernanceRule) -> String {
    let raw = rule
        .default_name
        .as_deref()
        .unwrap_or("tool")
        .trim()
        .to_string();
    if raw.is_empty() {
        return "tool".to_string();
    }
    raw
}

fn read_max_name_length(rule: &NativeToolGovernanceRule) -> usize {
    let raw = rule.max_name_length.unwrap_or(64);
    if raw < 1 {
        return 1;
    }
    raw as usize
}

fn allow_character_with_token(ch: char, token: &str) -> bool {
    let lowered = token.trim().to_ascii_lowercase();
    if lowered == "alpha_num" {
        return ch.is_ascii_alphanumeric() || ch == '_' || ch == '-';
    }
    if lowered == "lower_snake" {
        return ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_' || ch == '-';
    }
    ch.is_ascii_alphanumeric() || ch == '_' || ch == '-'
}

fn filter_allowed_characters(value: &str, token: &str) -> String {
    let trimmed = token.trim();
    if trimmed.is_empty() {
        return value.to_string();
    }
    let lowered = trimmed.to_ascii_lowercase();
    if lowered == "lower_snake" || lowered == "alpha_num" {
        return value
            .chars()
            .filter(|ch| allow_character_with_token(*ch, trimmed))
            .collect();
    }
    if let Ok(re) = Regex::new(trimmed) {
        return value
            .chars()
            .filter(|ch| re.is_match(&ch.to_string()))
            .collect();
    }
    value
        .chars()
        .filter(|ch| allow_character_with_token(*ch, "alpha_num"))
        .collect()
}

fn sanitize_name(
    raw_name: Option<&Value>,
    rule: &NativeToolGovernanceRule,
    stats: &mut GovernanceStats,
    field: &str,
) -> Result<String, String> {
    let default_name = read_default_name(rule);
    let mut next = raw_name.and_then(|v| v.as_str()).unwrap_or("").to_string();
    if rule.trim_whitespace.unwrap_or(true) {
        next = next.trim().to_string();
    }
    let mut changed = false;
    if next.is_empty() {
        next = default_name.clone();
        stats.defaulted_names += 1;
        changed = true;
    }

    match rule
        .force_case
        .as_deref()
        .map(|v| v.trim().to_ascii_lowercase())
    {
        Some(v) if v == "lower" => {
            let forced = next.to_ascii_lowercase();
            if forced != next {
                next = forced;
                changed = true;
            }
        }
        Some(v) if v == "upper" => {
            let forced = next.to_ascii_uppercase();
            if forced != next {
                next = forced;
                changed = true;
            }
        }
        _ => {}
    }

    if let Some(token) = rule.allowed_characters.as_deref() {
        let filtered = filter_allowed_characters(&next, token);
        if filtered.is_empty() {
            next = default_name.clone();
            stats.defaulted_names += 1;
            changed = true;
        } else if filtered != next {
            next = filtered;
            changed = true;
        }
    }

    let max_len = read_max_name_length(rule);
    if next.chars().count() > max_len {
        if rule
            .on_violation
            .as_deref()
            .map(|v| v.eq_ignore_ascii_case("reject"))
            .unwrap_or(false)
        {
            return Err(format!(
                "Tool name exceeds max length of {} ({})",
                max_len, field
            ));
        }
        next = next.chars().take(max_len).collect();
        stats.truncated_names += 1;
        changed = true;
    }

    if changed
        || raw_name
            .and_then(|v| v.as_str())
            .map(|raw| raw != next)
            .unwrap_or(true)
    {
        stats.sanitized_names += 1;
    }
    stats.applied = true;
    if next.is_empty() {
        return Ok(default_name);
    }
    Ok(next)
}

fn sanitize_tool_call_entry(
    call: &mut Value,
    rule: &NativeToolGovernanceRule,
    stats: &mut GovernanceStats,
    field: &str,
) -> Result<(), String> {
    let Some(call_obj) = call.as_object_mut() else {
        return Ok(());
    };
    let Some(function) = call_obj.get_mut("function") else {
        return Ok(());
    };
    let Some(function_obj) = function.as_object_mut() else {
        return Ok(());
    };
    let next_name = sanitize_name(function_obj.get("name"), rule, stats, field)?;
    function_obj.insert("name".to_string(), Value::String(next_name));
    Ok(())
}

fn sanitize_message_entry(
    message: &mut Value,
    rule: &NativeToolGovernanceRule,
    stats: &mut GovernanceStats,
) -> Result<(), String> {
    let Some(message_obj) = message.as_object_mut() else {
        return Ok(());
    };

    if let Some(Value::Array(tool_calls)) = message_obj.get_mut("tool_calls") {
        for call in tool_calls {
            sanitize_tool_call_entry(call, rule, stats, "tool_call.function.name")?;
        }
    }

    let role_is_tool = message_obj
        .get("role")
        .and_then(|v| v.as_str())
        .map(|v| v == "tool")
        .unwrap_or(false);
    if role_is_tool || message_obj.get("name").and_then(|v| v.as_str()).is_some() {
        let next_name = sanitize_name(message_obj.get("name"), rule, stats, "message.name")?;
        message_obj.insert("name".to_string(), Value::String(next_name));
    }

    Ok(())
}

fn sanitize_tool_entry(
    tool: &mut Value,
    rule: &NativeToolGovernanceRule,
    stats: &mut GovernanceStats,
) -> Result<(), String> {
    let Some(tool_obj) = tool.as_object_mut() else {
        return Ok(());
    };
    if !tool_obj.contains_key("function") || !tool_obj.get("function").unwrap().is_object() {
        tool_obj.insert("function".to_string(), Value::Object(Map::new()));
    }
    let Some(function_obj) = tool_obj
        .get_mut("function")
        .and_then(|value| value.as_object_mut())
    else {
        return Ok(());
    };
    let next_name = sanitize_name(function_obj.get("name"), rule, stats, "tool.function.name")?;
    function_obj.insert("name".to_string(), Value::String(next_name));
    Ok(())
}

fn govern_request(input: GovernRequestInput) -> Result<GovernRequestOutput, String> {
    let protocol = normalize_protocol(input.protocol.as_deref());
    let registry = parse_registry_candidate(input.registry.as_ref());
    let Some(rule) = resolve_request_rule(&protocol, &registry) else {
        return Ok(GovernRequestOutput {
            request: input.request,
            summary: ToolGovernanceSummary {
                protocol,
                direction: "request".to_string(),
                applied: false,
                sanitized_names: 0,
                truncated_names: 0,
                defaulted_names: 0,
                timestamp: now_millis(),
            },
        });
    };

    let mut request = match input.request {
        Value::Object(row) => row,
        _ => {
            return Err("request must be an object".to_string());
        }
    };

    let mut stats = GovernanceStats {
        protocol: protocol.clone(),
        applied: false,
        sanitized_names: 0,
        truncated_names: 0,
        defaulted_names: 0,
    };

    if let Some(Value::Array(messages)) = request.get_mut("messages") {
        for message in messages {
            sanitize_message_entry(message, &rule, &mut stats)?;
        }
    }

    if let Some(Value::Array(tools)) = request.get_mut("tools") {
        for tool in tools {
            sanitize_tool_entry(tool, &rule, &mut stats)?;
        }
    }

    let summary = ToolGovernanceSummary {
        protocol: stats.protocol.clone(),
        direction: "request".to_string(),
        applied: stats.applied,
        sanitized_names: stats.sanitized_names,
        truncated_names: stats.truncated_names,
        defaulted_names: stats.defaulted_names,
        timestamp: now_millis(),
    };

    if !request.contains_key("metadata") || !request.get("metadata").unwrap().is_object() {
        request.insert("metadata".to_string(), Value::Object(Map::new()));
    }
    if let Some(metadata) = request.get_mut("metadata").and_then(|v| v.as_object_mut()) {
        if !metadata.contains_key("toolGovernance")
            || !metadata.get("toolGovernance").unwrap().is_object()
        {
            metadata.insert("toolGovernance".to_string(), Value::Object(Map::new()));
        }
        if let Some(governance) = metadata
            .get_mut("toolGovernance")
            .and_then(|v| v.as_object_mut())
        {
            let summary_value = serde_json::to_value(&summary).unwrap_or(Value::Null);
            governance.insert("request".to_string(), summary_value);
        }
    }

    Ok(GovernRequestOutput {
        request: Value::Object(request),
        summary,
    })
}

fn sanitize_response_payload(
    payload: &mut Map<String, Value>,
    rule: &NativeToolGovernanceRule,
    stats: &mut GovernanceStats,
) -> Result<(), String> {
    if let Some(Value::Array(choices)) = payload.get_mut("choices") {
        for choice in choices.iter_mut() {
            let Some(choice_obj) = choice.as_object_mut() else {
                continue;
            };
            let Some(message) = choice_obj.get_mut("message") else {
                continue;
            };
            let Some(message_obj) = message.as_object_mut() else {
                continue;
            };

            if let Some(Value::Array(tool_calls)) = message_obj.get_mut("tool_calls") {
                for (index, call) in tool_calls.iter_mut().enumerate() {
                    let field = format!("choices[].message.tool_calls[{}].function.name", index);
                    sanitize_tool_call_entry(call, rule, stats, field.as_str())?;
                }
            }

            if let Some(Value::Object(function_call)) = message_obj.get_mut("function_call") {
                let next_name = sanitize_name(
                    function_call.get("name"),
                    rule,
                    stats,
                    "choices[].message.function_call.name",
                )?;
                function_call.insert("name".to_string(), Value::String(next_name));
            }

            let role_is_tool = message_obj
                .get("role")
                .and_then(|v| v.as_str())
                .map(|v| v == "tool")
                .unwrap_or(false);
            if role_is_tool || message_obj.get("name").and_then(|v| v.as_str()).is_some() {
                let next_name = sanitize_name(
                    message_obj.get("name"),
                    rule,
                    stats,
                    "choices[].message.name",
                )?;
                message_obj.insert("name".to_string(), Value::String(next_name));
            }
        }
    }

    if let Some(Value::Array(tool_calls)) = payload.get_mut("tool_calls") {
        for call in tool_calls.iter_mut() {
            sanitize_tool_call_entry(call, rule, stats, "tool_calls[].function.name")?;
        }
    }

    Ok(())
}

fn govern_response(input: GovernResponseInput) -> Result<GovernResponseOutput, String> {
    let protocol = normalize_protocol(input.protocol.as_deref());
    let registry = parse_registry_candidate(input.registry.as_ref());
    let Some(rule) = resolve_response_rule(&protocol, &registry) else {
        return Ok(GovernResponseOutput {
            payload: input.payload,
            summary: ToolGovernanceSummary {
                protocol,
                direction: "response".to_string(),
                applied: false,
                sanitized_names: 0,
                truncated_names: 0,
                defaulted_names: 0,
                timestamp: now_millis(),
            },
        });
    };

    let mut payload = match input.payload {
        Value::Object(row) => row,
        _ => {
            return Err("payload must be an object".to_string());
        }
    };

    let mut stats = GovernanceStats {
        protocol: protocol.clone(),
        applied: false,
        sanitized_names: 0,
        truncated_names: 0,
        defaulted_names: 0,
    };

    sanitize_response_payload(&mut payload, &rule, &mut stats)?;

    let summary = ToolGovernanceSummary {
        protocol: stats.protocol.clone(),
        direction: "response".to_string(),
        applied: stats.applied,
        sanitized_names: stats.sanitized_names,
        truncated_names: stats.truncated_names,
        defaulted_names: stats.defaulted_names,
        timestamp: now_millis(),
    };

    Ok(GovernResponseOutput {
        payload: Value::Object(payload),
        summary,
    })
}

#[napi]
pub fn govern_request_json(input_json: String) -> NapiResult<String> {
    if input_json.trim().is_empty() {
        return Err(napi::Error::from_reason("Input JSON is empty"));
    }
    let input: GovernRequestInput = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input JSON: {}", e)))?;
    let output = govern_request(input).map_err(napi::Error::from_reason)?;
    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)))
}

#[napi]
pub fn govern_tool_name_response_json(input_json: String) -> NapiResult<String> {
    if input_json.trim().is_empty() {
        return Err(napi::Error::from_reason("Input JSON is empty"));
    }
    let input: GovernResponseInput = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input JSON: {}", e)))?;
    let output = govern_response(input).map_err(napi::Error::from_reason)?;
    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)))
}

#[napi]
pub fn resolve_default_tool_governance_rules_json() -> NapiResult<String> {
    let output = default_registry();
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_default_rules_has_expected_protocols() {
        let rules = default_registry();
        assert!(rules.contains_key("openai-chat"));
        assert!(rules.contains_key("openai-responses"));
        assert!(rules.contains_key("anthropic"));
        assert!(rules.contains_key("gemini"));
    }

    #[test]
    fn govern_request_truncates_tool_names_and_writes_summary() {
        let input = GovernRequestInput {
            request: serde_json::json!({
                "model": "gpt-test",
                "messages": [
                    {
                        "role": "assistant",
                        "tool_calls": [
                            { "function": { "name": "X".repeat(80), "arguments": "{}" } }
                        ]
                    },
                    {
                        "role": "tool",
                        "name": "  __BAD__NAME__  "
                    }
                ],
                "tools": [
                    { "type": "function", "function": { "name": "Y".repeat(80), "parameters": {} } }
                ],
                "metadata": {}
            }),
            protocol: Some("openai-chat".to_string()),
            registry: None,
        };

        let output = govern_request(input).expect("govern request");
        let request = output.request.as_object().expect("request object");
        let tools = request
            .get("tools")
            .and_then(|v| v.as_array())
            .expect("tools array");
        let tool_name = tools[0]
            .get("function")
            .and_then(|v| v.get("name"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        assert_eq!(tool_name.len(), 64);

        let metadata = request
            .get("metadata")
            .and_then(|v| v.as_object())
            .expect("metadata object");
        let summary = metadata
            .get("toolGovernance")
            .and_then(|v| v.get("request"))
            .and_then(|v| v.as_object())
            .expect("summary object");
        assert_eq!(
            summary.get("direction").and_then(|v| v.as_str()),
            Some("request")
        );
        assert_eq!(summary.get("applied").and_then(|v| v.as_bool()), Some(true));
    }

    #[test]
    fn govern_request_respects_reject_mode() {
        let input = GovernRequestInput {
            request: serde_json::json!({
                "messages": [{ "role": "tool", "name": "TOO-LONG-NAME-REJECT" }]
            }),
            protocol: Some("gemini-chat".to_string()),
            registry: Some(serde_json::json!({
                "gemini": {
                    "request": {
                        "maxNameLength": 3,
                        "allowedCharacters": "alpha_num",
                        "defaultName": "tool",
                        "trimWhitespace": true,
                        "onViolation": "reject"
                    }
                }
            })),
        };

        let error = govern_request(input).expect_err("expected reject error");
        assert!(error.contains("Tool name exceeds max length"));
    }

    #[test]
    fn govern_response_sanitizes_names() {
        let input = GovernResponseInput {
            payload: serde_json::json!({
                "choices": [
                    {
                        "message": {
                            "role": "assistant",
                            "tool_calls": [
                                { "function": { "name": "BAD$$NAME", "arguments": "{}" } }
                            ],
                            "function_call": { "name": "TOOL_123", "arguments": "{}" },
                            "name": "mixedCase"
                        }
                    }
                ],
                "tool_calls": [
                    { "function": { "name": "ALSO_BAD$$", "arguments": "{}" } }
                ]
            }),
            protocol: Some("openai-chat".to_string()),
            registry: Some(serde_json::json!({
                "openai-chat": {
                    "response": {
                        "maxNameLength": 5,
                        "allowedCharacters": "[a-z]",
                        "defaultName": "tool",
                        "trimWhitespace": true,
                        "forceCase": "lower",
                        "onViolation": "truncate"
                    }
                }
            })),
        };

        let output = govern_response(input).expect("govern response");
        let payload = output.payload.as_object().expect("payload object");
        let choices = payload
            .get("choices")
            .and_then(|v| v.as_array())
            .expect("choices");
        let message = choices[0]
            .get("message")
            .and_then(|v| v.as_object())
            .expect("message");
        let tool_calls = message
            .get("tool_calls")
            .and_then(|v| v.as_array())
            .expect("tool_calls");
        let name = tool_calls[0]
            .get("function")
            .and_then(|v| v.get("name"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        assert_eq!(name, "badna");
    }

    #[test]
    fn govern_response_respects_reject_mode() {
        let input = GovernResponseInput {
            payload: serde_json::json!({
                "choices": [
                    {
                        "message": {
                            "role": "assistant",
                            "tool_calls": [
                                { "function": { "name": "TOO-LONG-NAME", "arguments": "{}" } }
                            ]
                        }
                    }
                ]
            }),
            protocol: Some("openai-chat".to_string()),
            registry: Some(serde_json::json!({
                "openai-chat": {
                    "response": {
                        "maxNameLength": 2,
                        "allowedCharacters": "alpha_num",
                        "defaultName": "tool",
                        "trimWhitespace": true,
                        "onViolation": "reject"
                    }
                }
            })),
        };

        let error = govern_response(input).expect_err("expected reject error");
        assert!(error.contains("Tool name exceeds max length"));
    }
}
