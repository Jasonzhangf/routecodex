use chrono;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Map;
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HubPipelineInput {
    pub request_id: String,
    pub endpoint: String,
    pub entry_endpoint: String,
    pub provider_protocol: String,
    pub payload: Value,
    pub metadata: Value,
    #[serde(default)]
    pub stream: bool,
    #[serde(default)]
    pub process_mode: String,
    #[serde(default)]
    pub direction: String,
    #[serde(default)]
    pub stage: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HubPipelineOutput {
    pub request_id: String,
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<HubPipelineError>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HubPipelineError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineStageResult {
    pub stage_id: String,
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormatEnvelope {
    pub protocol: String,
    pub payload: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatEnvelope {
    pub messages: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub semantics: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutingDecision {
    pub provider_key: String,
    pub target_endpoint: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessedRequest {
    pub request: Value,
    pub routing: RoutingDecision,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
}

fn normalize_endpoint(endpoint: &str) -> String {
    let trimmed = endpoint.trim();
    if trimmed.is_empty() {
        return "/v1/chat/completions".to_string();
    }
    let normalized = if trimmed.starts_with('/') {
        trimmed.to_string()
    } else {
        format!("/{}", trimmed)
    };
    normalized.replace("//", "/")
}

fn resolve_provider_protocol(value: &str) -> Result<String, String> {
    if value.trim().is_empty() {
        return Ok("openai-chat".to_string());
    }
    let normalized = value.trim().to_lowercase();
    match normalized.as_str() {
        "openai-chat" | "openai" | "chat" => Ok("openai-chat".to_string()),
        "responses" | "openai-responses" => Ok("openai-responses".to_string()),
        "anthropic-messages" | "anthropic" | "messages" => Ok("anthropic-messages".to_string()),
        "gemini-chat" | "gemini" | "google-gemini" => Ok("gemini-chat".to_string()),
        _ => Err(format!("Unsupported providerProtocol: {}", value)),
    }
}

fn resolve_hub_client_protocol(entry_endpoint: &str) -> String {
    let lowered = entry_endpoint.to_ascii_lowercase();
    if lowered.contains("/v1/responses") {
        return "openai-responses".to_string();
    }
    if lowered.contains("/v1/messages") {
        return "anthropic-messages".to_string();
    }
    "openai-chat".to_string()
}

fn resolve_outbound_stream_intent(provider_preference: &Value) -> Option<bool> {
    let token = provider_preference
        .as_str()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_default();
    match token.as_str() {
        "always" => Some(true),
        "never" => Some(false),
        _ => None,
    }
}

fn apply_outbound_stream_preference(
    request: &Value,
    stream: Option<bool>,
    process_mode: Option<&str>,
) -> Value {
    let Some(request_obj) = request.as_object() else {
        return request.clone();
    };
    let mode = process_mode.unwrap_or("").trim().to_ascii_lowercase();
    if mode == "passthrough" && stream.is_none() {
        return Value::Object(request_obj.clone());
    }

    let mut out = request_obj.clone();
    match stream {
        Some(stream_value) => {
            if !out.get("parameters").and_then(|v| v.as_object()).is_some() {
                out.insert("parameters".to_string(), Value::Object(Map::new()));
            }
            if let Some(parameters) = out.get_mut("parameters").and_then(|v| v.as_object_mut()) {
                parameters.insert("stream".to_string(), Value::Bool(stream_value));
            }
            if !out.get("metadata").and_then(|v| v.as_object()).is_some() {
                out.insert("metadata".to_string(), Value::Object(Map::new()));
            }
            if let Some(metadata) = out.get_mut("metadata").and_then(|v| v.as_object_mut()) {
                metadata.insert("outboundStream".to_string(), Value::Bool(stream_value));
            }
        }
        None => {
            if let Some(parameters) = out.get_mut("parameters").and_then(|v| v.as_object_mut()) {
                parameters.remove("stream");
            }
            if let Some(metadata) = out.get_mut("metadata").and_then(|v| v.as_object_mut()) {
                metadata.remove("outboundStream");
            }
        }
    }

    Value::Object(out)
}

fn resolve_sse_protocol_from_metadata(metadata: &Value) -> Option<String> {
    let row = metadata.as_object()?;
    for key in ["sseProtocol", "clientSseProtocol", "routeSseProtocol"] {
        let raw = match row.get(key).and_then(|v| v.as_str()) {
            Some(v) => v.trim(),
            None => continue,
        };
        if raw.is_empty() {
            continue;
        }
        if let Ok(protocol) = resolve_provider_protocol(raw) {
            return Some(protocol);
        }
    }
    None
}

fn read_trimmed_string_token(metadata: &Map<String, Value>, keys: &[&str]) -> Option<String> {
    for key in keys {
        let raw = match metadata.get(*key).and_then(|v| v.as_str()) {
            Some(v) => v.trim(),
            None => continue,
        };
        if !raw.is_empty() {
            return Some(raw.to_string());
        }
    }
    None
}

fn resolve_stop_message_router_metadata(metadata: &Value) -> Value {
    let mut out = Map::<String, Value>::new();
    let metadata_obj = match metadata.as_object() {
        Some(v) => v,
        None => return Value::Object(out),
    };

    if let Some(scope) =
        read_trimmed_string_token(metadata_obj, &["stopMessageClientInjectSessionScope"])
    {
        out.insert(
            "stopMessageClientInjectSessionScope".to_string(),
            Value::String(scope),
        );
    }
    if let Some(scope) = read_trimmed_string_token(metadata_obj, &["stopMessageClientInjectScope"])
    {
        out.insert(
            "stopMessageClientInjectScope".to_string(),
            Value::String(scope),
        );
    }

    let client_tmux = read_trimmed_string_token(
        metadata_obj,
        &["clientTmuxSessionId", "client_tmux_session_id"],
    );
    let tmux = read_trimmed_string_token(metadata_obj, &["tmuxSessionId", "tmux_session_id"]);
    let resolved_tmux = client_tmux.or(tmux);
    if let Some(tmux_id) = resolved_tmux {
        out.insert(
            "clientTmuxSessionId".to_string(),
            Value::String(tmux_id.clone()),
        );
        out.insert(
            "client_tmux_session_id".to_string(),
            Value::String(tmux_id.clone()),
        );
        out.insert("tmuxSessionId".to_string(), Value::String(tmux_id.clone()));
        out.insert("tmux_session_id".to_string(), Value::String(tmux_id));
    }

    Value::Object(out)
}

fn extract_adapter_context_metadata_fields(metadata: &Value, keys: &Value) -> Value {
    let metadata_obj = match metadata.as_object() {
        Some(v) => v,
        None => return Value::Object(Map::new()),
    };
    let key_rows = match keys.as_array() {
        Some(v) => v,
        None => return Value::Object(Map::new()),
    };

    let mut out = Map::<String, Value>::new();
    for entry in key_rows {
        let key = match entry.as_str() {
            Some(v) => v.trim(),
            None => continue,
        };
        if key.is_empty() {
            continue;
        }
        let Some(raw) = metadata_obj.get(key) else {
            continue;
        };
        match raw {
            Value::Bool(v) => {
                out.insert(key.to_string(), Value::Bool(*v));
            }
            Value::String(v) => {
                let trimmed = v.trim();
                if !trimmed.is_empty() {
                    out.insert(key.to_string(), Value::String(trimmed.to_string()));
                }
            }
            _ => {}
        }
    }
    Value::Object(out)
}

fn normalize_policy_mode(raw: Option<&str>) -> Option<String> {
    let candidate = raw.unwrap_or("").trim().to_ascii_lowercase();
    match candidate.as_str() {
        "off" | "observe" | "enforce" => Some(candidate),
        _ => None,
    }
}

fn resolve_hub_policy_override(metadata: &Value) -> Option<Value> {
    let metadata_obj = metadata.as_object()?;
    let raw = metadata_obj.get("__hubPolicyOverride")?;
    let override_obj = raw.as_object()?;

    let mode = normalize_policy_mode(override_obj.get("mode").and_then(|v| v.as_str()))?;
    let mut out = Map::<String, Value>::new();
    out.insert("mode".to_string(), Value::String(mode));

    if let Some(sample_rate) = override_obj.get("sampleRate").and_then(|v| v.as_f64()) {
        if sample_rate.is_finite() {
            if let Some(number) = serde_json::Number::from_f64(sample_rate) {
                out.insert("sampleRate".to_string(), Value::Number(number));
            }
        }
    }

    Some(Value::Object(out))
}

fn resolve_hub_shadow_compare_config(metadata: &Value) -> Option<Value> {
    let metadata_obj = metadata.as_object()?;
    let raw = metadata_obj.get("__hubShadowCompare")?;
    let shadow_obj = raw.as_object()?;

    let baseline_mode = normalize_policy_mode(
        shadow_obj
            .get("baselineMode")
            .and_then(|v| v.as_str())
            .or_else(|| shadow_obj.get("mode").and_then(|v| v.as_str())),
    )?;

    let mut out = Map::<String, Value>::new();
    out.insert("baselineMode".to_string(), Value::String(baseline_mode));
    Some(Value::Object(out))
}

fn normalize_apply_patch_tool_mode_token(raw: Option<&str>) -> Option<String> {
    let token = raw.unwrap_or("").trim().to_ascii_lowercase();
    match token.as_str() {
        "freeform" => Some("freeform".to_string()),
        "schema" | "json_schema" => Some("schema".to_string()),
        _ => None,
    }
}

fn resolve_apply_patch_tool_mode_from_tools(tools_raw: &Value) -> Option<String> {
    let tools = tools_raw.as_array()?;
    if tools.is_empty() {
        return None;
    }
    for entry in tools {
        let record = match entry.as_object() {
            Some(v) => v,
            None => continue,
        };
        let tool_type = record
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if !tool_type.is_empty() && tool_type != "function" {
            continue;
        }
        let fn_obj = record.get("function").and_then(|v| v.as_object());
        let name = fn_obj
            .and_then(|obj| obj.get("name"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if name != "apply_patch" {
            continue;
        }
        let format = normalize_apply_patch_tool_mode_token(
            record.get("format").and_then(|v| v.as_str()).or_else(|| {
                fn_obj
                    .and_then(|obj| obj.get("format"))
                    .and_then(|v| v.as_str())
            }),
        );
        // If apply_patch exists without explicit freeform marker, default to schema mode.
        return Some(format.unwrap_or_else(|| "schema".to_string()));
    }
    None
}

fn is_passthrough_canonical_chat_key(key: &str) -> bool {
    matches!(
        key,
        "model" | "messages" | "tools" | "parameters" | "metadata" | "semantics" | "stream"
    )
}

fn value_as_object_or_empty(value: &Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

fn collect_passthrough_todo_top_level_keys(payload: &Map<String, Value>) -> Vec<Value> {
    let mut keys = payload
        .keys()
        .filter(|key| !is_passthrough_canonical_chat_key(key.as_str()))
        .cloned()
        .collect::<Vec<String>>();
    keys.sort();
    keys.into_iter().map(Value::String).collect::<Vec<Value>>()
}

fn build_passthrough_audit(raw_inbound: &Value, provider_protocol: &str) -> Value {
    let inbound_record = value_as_object_or_empty(raw_inbound);
    let mut raw = Map::<String, Value>::new();
    raw.insert("inbound".to_string(), Value::Object(inbound_record.clone()));

    let mut inbound_todo = Map::<String, Value>::new();
    inbound_todo.insert(
        "unmappedTopLevelKeys".to_string(),
        Value::Array(collect_passthrough_todo_top_level_keys(&inbound_record)),
    );
    inbound_todo.insert(
        "providerProtocol".to_string(),
        Value::String(provider_protocol.to_string()),
    );
    inbound_todo.insert(
        "note".to_string(),
        Value::String("passthrough_mode_parse_record_only".to_string()),
    );

    let mut todo = Map::<String, Value>::new();
    todo.insert("inbound".to_string(), Value::Object(inbound_todo));

    let mut out = Map::<String, Value>::new();
    out.insert("raw".to_string(), Value::Object(raw));
    out.insert("todo".to_string(), Value::Object(todo));
    Value::Object(out)
}

fn ensure_object_field_mut<'a>(
    root: &'a mut Map<String, Value>,
    key: &str,
) -> &'a mut Map<String, Value> {
    if !root.get(key).and_then(|v| v.as_object()).is_some() {
        root.insert(key.to_string(), Value::Object(Map::new()));
    }
    root.get_mut(key)
        .and_then(|v| v.as_object_mut())
        .expect("object field")
}

fn annotate_passthrough_governance_skip(audit: &Value) -> Value {
    let mut out = value_as_object_or_empty(audit);
    let todo = ensure_object_field_mut(&mut out, "todo");
    let mut governance = Map::<String, Value>::new();
    governance.insert("skipped".to_string(), Value::Bool(true));
    governance.insert(
        "reason".to_string(),
        Value::String("process_mode_passthrough".to_string()),
    );
    todo.insert("governance".to_string(), Value::Object(governance));
    Value::Object(out)
}

fn attach_passthrough_provider_input_audit(
    audit: &Value,
    provider_payload: &Value,
    provider_protocol: &str,
) -> Value {
    let mut out = value_as_object_or_empty(audit);
    let provider_record = value_as_object_or_empty(provider_payload);
    {
        let raw = ensure_object_field_mut(&mut out, "raw");
        raw.insert(
            "providerInput".to_string(),
            Value::Object(provider_record.clone()),
        );
    }
    {
        let todo = ensure_object_field_mut(&mut out, "todo");
        let mut outbound = Map::<String, Value>::new();
        outbound.insert(
            "unmappedTopLevelKeys".to_string(),
            Value::Array(collect_passthrough_todo_top_level_keys(&provider_record)),
        );
        outbound.insert(
            "providerProtocol".to_string(),
            Value::String(provider_protocol.to_string()),
        );
        outbound.insert(
            "note".to_string(),
            Value::String("provider_payload_not_mapped_back_to_chat_semantics".to_string()),
        );
        todo.insert("outbound".to_string(), Value::Object(outbound));
    }
    Value::Object(out)
}

fn extract_message_text_from_value(message: &Value) -> String {
    let Some(record) = message.as_object() else {
        return String::new();
    };
    if let Some(content) = record.get("content").and_then(|v| v.as_str()) {
        if !content.trim().is_empty() {
            return content.to_string();
        }
    }
    let Some(content_parts) = record.get("content").and_then(|v| v.as_array()) else {
        return String::new();
    };
    let mut parts: Vec<String> = Vec::new();
    for entry in content_parts {
        if let Some(text) = entry.as_str() {
            if !text.trim().is_empty() {
                parts.push(text.to_string());
            }
            continue;
        }
        let Some(part_obj) = entry.as_object() else {
            continue;
        };
        if let Some(text) = part_obj.get("text").and_then(|v| v.as_str()) {
            if !text.trim().is_empty() {
                parts.push(text.to_string());
                continue;
            }
        }
        if let Some(text) = part_obj.get("content").and_then(|v| v.as_str()) {
            if !text.trim().is_empty() {
                parts.push(text.to_string());
            }
        }
    }
    let joined = parts.join("\n");
    let trimmed = joined.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    trimmed.to_string()
}

fn strip_code_segments(text: &str) -> String {
    if text.is_empty() {
        return String::new();
    }
    let fenced_backticks = Regex::new(r"(?s)```.*?```").unwrap();
    let fenced_tildes = Regex::new(r"(?s)~~~.*?~~~").unwrap();
    let inline_code = Regex::new(r"`[^`]*`").unwrap();
    let sanitized = fenced_backticks.replace_all(text, " ");
    let sanitized = fenced_tildes.replace_all(&sanitized, " ");
    inline_code.replace_all(&sanitized, " ").into_owned()
}

fn normalize_instruction_leading(content: &str) -> String {
    let mut char_indices = content.char_indices();
    let mut start = 0usize;
    while let Some((idx, ch)) = char_indices.next() {
        let is_zero_width = ch == '\u{200B}'
            || ch == '\u{200C}'
            || ch == '\u{200D}'
            || ch == '\u{2060}'
            || ch == '\u{FEFF}';
        if is_zero_width {
            start = idx + ch.len_utf8();
            continue;
        }
        break;
    }
    content[start..].trim_start().to_string()
}

fn split_instruction_targets(content: &str) -> Vec<String> {
    content
        .split(',')
        .map(|segment| segment.trim().to_string())
        .filter(|segment| !segment.is_empty())
        .collect()
}

fn normalize_split_stop_message_head_token(token: &str) -> String {
    let normalized = normalize_instruction_leading(token);
    normalized
        .trim_matches(|ch| ch == '"' || ch == '\'')
        .trim()
        .to_string()
}

fn recover_split_stop_message_instruction(tokens: &[String]) -> Option<String> {
    if tokens.len() < 2 {
        return None;
    }
    let head = normalize_split_stop_message_head_token(tokens[0].as_str());
    if !head.eq_ignore_ascii_case("stopmessage") {
        return None;
    }
    let tail = tokens[1..].join(",").trim().to_string();
    if tail.is_empty() {
        return None;
    }
    Some(format!("stopMessage:{}", tail))
}

fn normalize_stop_message_command_prefix(content: &str) -> String {
    let normalized = normalize_instruction_leading(content);
    let re = Regex::new(r#"^(?:"|')?stopMessage(?:"|')?\s*([:,])"#).unwrap();
    re.replace(&normalized, "stopMessage$1").to_string()
}

fn expand_instruction_segments(instruction: &str) -> Vec<String> {
    let trimmed = instruction.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    let normalized_leading = normalize_instruction_leading(trimmed);
    let stop_message_re = Regex::new(r#"^(?:"|')?stopMessage(?:"|')?\s*[:,]"#).unwrap();
    if stop_message_re.is_match(&normalized_leading) {
        return vec![normalize_stop_message_command_prefix(&normalized_leading)];
    }
    let pre_command_re = Regex::new(r"(?i)^precommand(?:\s*:|$)").unwrap();
    if pre_command_re.is_match(&normalized_leading) {
        return vec![normalized_leading];
    }

    let mut chars = trimmed.chars();
    let prefix = chars.next().unwrap_or_default();
    if prefix == '!' || prefix == '#' || prefix == '@' {
        let targets = split_instruction_targets(chars.as_str());
        return targets
            .iter()
            .map(|token| {
                token
                    .trim_start_matches(|ch| ch == '!' || ch == '#' || ch == '@')
                    .trim()
                    .to_string()
            })
            .filter(|token| !token.is_empty())
            .map(|token| format!("{}{}", prefix, token))
            .collect();
    }

    let split_tokens = split_instruction_targets(trimmed);
    if let Some(recovered) = recover_split_stop_message_instruction(split_tokens.as_slice()) {
        return vec![recovered];
    }
    split_tokens
}

fn is_valid_identifier(id: &str) -> bool {
    Regex::new(r"^[a-zA-Z0-9_-]+$").unwrap().is_match(id)
}

fn is_valid_model_token(token: &str) -> bool {
    Regex::new(r"^[a-zA-Z0-9_.-]+$").unwrap().is_match(token)
}

fn parse_target_is_valid(target: &str) -> bool {
    if target.is_empty() {
        return false;
    }
    let bracket_re = Regex::new(r"^([a-zA-Z0-9_-]+)\[([a-zA-Z0-9_-]*)\](?:\.(.+))?$").unwrap();
    if let Some(captures) = bracket_re.captures(target) {
        let provider = captures.get(1).map(|m| m.as_str()).unwrap_or("").trim();
        let key_alias = captures.get(2).map(|m| m.as_str()).unwrap_or("").trim();
        let model = captures.get(3).map(|m| m.as_str()).unwrap_or("").trim();
        if provider.is_empty() || !is_valid_identifier(provider) {
            return false;
        }
        if key_alias.is_empty() {
            return model.is_empty() || is_valid_model_token(model);
        }
        if !is_valid_identifier(key_alias) {
            return false;
        }
        return model.is_empty() || is_valid_model_token(model);
    }

    let Some(first_dot) = target.find('.') else {
        let provider = target.trim();
        return !provider.is_empty() && is_valid_identifier(provider);
    };
    let provider = target[..first_dot].trim();
    let remainder = target[first_dot + 1..].trim();
    if provider.is_empty() || remainder.is_empty() || !is_valid_identifier(provider) {
        return false;
    }
    if remainder.chars().all(|ch| ch.is_ascii_digit()) {
        return remainder.parse::<u32>().map(|v| v > 0).unwrap_or(false);
    }
    is_valid_model_token(remainder)
}

fn split_target_and_process_mode(raw_target: &str) -> (String, Option<String>) {
    let trimmed = raw_target.trim();
    if trimmed.is_empty() {
        return (String::new(), None);
    }
    let Some(separator_index) = trimmed.rfind(':') else {
        return (trimmed.to_string(), None);
    };
    if separator_index == 0 || separator_index + 1 >= trimmed.len() {
        return (trimmed.to_string(), None);
    }
    let target = trimmed[..separator_index].trim();
    let mode_token = trimmed[separator_index + 1..].trim().to_ascii_lowercase();
    if target.is_empty() {
        return (trimmed.to_string(), None);
    }
    match mode_token.as_str() {
        "passthrough" => (target.to_string(), Some("passthrough".to_string())),
        "chat" => (target.to_string(), Some("chat".to_string())),
        _ => (target.to_string(), None),
    }
}

fn parse_named_target_instruction_requests_passthrough(instruction: &str, prefix: &str) -> bool {
    let re = Regex::new(format!(r"(?i)^{}\s*:", regex::escape(prefix)).as_str()).unwrap();
    if !re.is_match(instruction) {
        return false;
    }
    let body_start = instruction.find(':').unwrap_or(0);
    let body = instruction[body_start + 1..].trim();
    if body.is_empty() {
        return false;
    }
    let (target, process_mode) = split_target_and_process_mode(body);
    if !parse_target_is_valid(target.as_str()) {
        return false;
    }
    matches!(process_mode.as_deref(), Some("passthrough"))
}

fn parse_single_instruction_requests_passthrough(instruction: &str) -> bool {
    if parse_named_target_instruction_requests_passthrough(instruction, "sticky")
        || parse_named_target_instruction_requests_passthrough(instruction, "force")
        || parse_named_target_instruction_requests_passthrough(instruction, "prefer")
    {
        return true;
    }
    if instruction.starts_with('!') {
        let raw_target = instruction[1..].trim();
        let (target, process_mode) = split_target_and_process_mode(raw_target);
        if target.is_empty() || !parse_target_is_valid(target.as_str()) {
            return false;
        }
        if !target.contains('.') {
            return false;
        }
        return matches!(process_mode.as_deref(), Some("passthrough"));
    }
    false
}

fn resolve_has_instruction_requested_passthrough(messages: &Value) -> bool {
    let Some(rows) = messages.as_array() else {
        return false;
    };
    if rows.is_empty() {
        return false;
    }
    let latest = match rows.last().and_then(|v| v.as_object()) {
        Some(v) => v,
        None => return false,
    };
    if latest
        .get("role")
        .and_then(|v| v.as_str())
        .map(|v| v == "user")
        != Some(true)
    {
        return false;
    }
    let content = extract_message_text_from_value(&Value::Object(latest.clone()));
    if content.is_empty() {
        return false;
    }
    let sanitized = strip_code_segments(content.as_str());
    if sanitized.is_empty() {
        return false;
    }
    let marker_re = Regex::new(r"(?s)<\*\*(.*?)\*\*>").unwrap();
    if !marker_re.is_match(&sanitized) {
        return false;
    }
    for captures in marker_re.captures_iter(&sanitized) {
        let instruction = captures
            .get(1)
            .map(|m| m.as_str().trim().to_string())
            .unwrap_or_default();
        if instruction.is_empty() {
            continue;
        }
        for segment in expand_instruction_segments(instruction.as_str()) {
            if parse_single_instruction_requests_passthrough(segment.as_str()) {
                return true;
            }
        }
    }
    false
}

fn resolve_active_process_mode(base_mode: &str, messages: &Value) -> String {
    if base_mode.eq_ignore_ascii_case("passthrough") {
        return "passthrough".to_string();
    }
    if resolve_has_instruction_requested_passthrough(messages) {
        return "passthrough".to_string();
    }
    "chat".to_string()
}

fn find_mappable_semantics_keys(metadata: &Value) -> Vec<String> {
    let Some(row) = metadata.as_object() else {
        return Vec::new();
    };
    let banned = [
        "responsesResume",
        "responses_resume",
        "clientToolsRaw",
        "client_tools_raw",
        "anthropicToolNameMap",
        "anthropic_tool_name_map",
        "responsesContext",
        "responses_context",
        "responseFormat",
        "response_format",
        "systemInstructions",
        "system_instructions",
        "toolsFieldPresent",
        "tools_field_present",
        "extraFields",
        "extra_fields",
    ];
    banned
        .iter()
        .filter(|key| row.contains_key(**key))
        .map(|key| key.to_string())
        .collect()
}

pub fn run_hub_pipeline(input: HubPipelineInput) -> Result<HubPipelineOutput, String> {
    // Main pipeline orchestration
    let request_id = input.request_id.clone();

    // Validate and normalize endpoint
    let _endpoint = normalize_endpoint(&input.endpoint);
    let _entry_endpoint = normalize_endpoint(&input.entry_endpoint);

    // Resolve provider protocol
    let provider_protocol = resolve_provider_protocol(&input.provider_protocol)
        .map_err(|e| format!("Protocol resolution failed: {}", e))?;

    // Basic payload validation
    if !input.payload.is_object() && !input.payload.is_array() {
        return Err("Payload must be a JSON object or array".to_string());
    }

    // Create success output with processed metadata
    let mut output_metadata = input.metadata.clone();
    if let Some(obj) = output_metadata.as_object_mut() {
        obj.insert(
            "providerProtocol".to_string(),
            Value::String(provider_protocol),
        );
        obj.insert(
            "processedAt".to_string(),
            Value::String(chrono::Utc::now().to_rfc3339()),
        );
    }

    Ok(HubPipelineOutput {
        request_id,
        success: true,
        payload: Some(input.payload),
        metadata: Some(output_metadata),
        error: None,
    })
}

pub fn run_req_inbound_pipeline(
    payload: Value,
    protocol: &str,
    endpoint: &str,
) -> Result<FormatEnvelope, String> {
    if payload.is_null() {
        return Err("Request payload cannot be null".to_string());
    }

    let normalized_protocol = resolve_provider_protocol(protocol)?;

    Ok(FormatEnvelope {
        protocol: normalized_protocol,
        payload,
        metadata: Some(serde_json::json!({
            "endpoint": endpoint,
            "processed": true
        })),
    })
}

pub fn run_req_process_pipeline(
    envelope: ChatEnvelope,
    routing: RoutingDecision,
) -> Result<ProcessedRequest, String> {
    if envelope.messages.is_empty() {
        return Err("Chat envelope must contain at least one message".to_string());
    }

    let request = serde_json::json!({
        "messages": envelope.messages,
        "semantics": envelope.semantics,
    });

    Ok(ProcessedRequest {
        request,
        routing,
        metadata: envelope.metadata,
    })
}

pub fn run_resp_outbound_pipeline(
    payload: Value,
    protocol: &str,
) -> Result<FormatEnvelope, String> {
    let normalized_protocol = resolve_provider_protocol(protocol)?;

    Ok(FormatEnvelope {
        protocol: normalized_protocol,
        payload,
        metadata: None,
    })
}

#[napi_derive::napi]
pub fn normalize_hub_endpoint_json(endpoint: String) -> napi::Result<String> {
    let output = normalize_endpoint(&endpoint);
    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize endpoint: {}", e)))
}

#[napi_derive::napi]
pub fn resolve_provider_protocol_json(value: String) -> napi::Result<String> {
    let output = resolve_provider_protocol(&value).map_err(|e| napi::Error::from_reason(e))?;
    serde_json::to_string(&output).map_err(|e| {
        napi::Error::from_reason(format!("Failed to serialize provider protocol: {}", e))
    })
}

#[napi_derive::napi]
pub fn resolve_hub_client_protocol_json(entry_endpoint: String) -> napi::Result<String> {
    let output = resolve_hub_client_protocol(&entry_endpoint);
    serde_json::to_string(&output).map_err(|e| {
        napi::Error::from_reason(format!("Failed to serialize hub client protocol: {}", e))
    })
}

#[napi_derive::napi]
pub fn resolve_outbound_stream_intent_json(
    provider_preference_json: String,
) -> napi::Result<String> {
    let provider_preference: Value =
        serde_json::from_str(&provider_preference_json).map_err(|e| {
            napi::Error::from_reason(format!("Failed to parse provider preference JSON: {}", e))
        })?;
    let output = resolve_outbound_stream_intent(&provider_preference);
    serde_json::to_string(&output).map_err(|e| {
        napi::Error::from_reason(format!("Failed to serialize outbound stream intent: {}", e))
    })
}

#[napi_derive::napi]
pub fn apply_outbound_stream_preference_json(
    request_json: String,
    stream_json: String,
    process_mode_json: String,
) -> napi::Result<String> {
    let request: Value = serde_json::from_str(&request_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse request JSON: {}", e)))?;
    let stream_value: Value = serde_json::from_str(&stream_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse stream JSON: {}", e)))?;
    let process_mode_value: Value = serde_json::from_str(&process_mode_json).map_err(|e| {
        napi::Error::from_reason(format!("Failed to parse process mode JSON: {}", e))
    })?;
    let stream = stream_value.as_bool();
    let process_mode = process_mode_value.as_str();
    let output = apply_outbound_stream_preference(&request, stream, process_mode);
    serde_json::to_string(&output).map_err(|e| {
        napi::Error::from_reason(format!(
            "Failed to serialize stream preference output: {}",
            e
        ))
    })
}

#[napi_derive::napi]
pub fn resolve_sse_protocol_from_metadata_json(metadata_json: String) -> napi::Result<String> {
    let metadata: Value = serde_json::from_str(&metadata_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse metadata JSON: {}", e)))?;
    let output = resolve_sse_protocol_from_metadata(&metadata);
    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize sse protocol: {}", e)))
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
pub fn extract_adapter_context_metadata_fields_json(
    metadata_json: String,
    keys_json: String,
) -> napi::Result<String> {
    let metadata: Value = serde_json::from_str(&metadata_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse metadata JSON: {}", e)))?;
    let keys: Value = serde_json::from_str(&keys_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse keys JSON: {}", e)))?;
    let output = extract_adapter_context_metadata_fields(&metadata, &keys);
    serde_json::to_string(&output).map_err(|e| {
        napi::Error::from_reason(format!(
            "Failed to serialize adapter context metadata fields: {}",
            e
        ))
    })
}

#[napi_derive::napi]
pub fn resolve_hub_policy_override_json(metadata_json: String) -> napi::Result<String> {
    let metadata: Value = serde_json::from_str(&metadata_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse metadata JSON: {}", e)))?;
    let output = resolve_hub_policy_override(&metadata).unwrap_or(Value::Null);
    serde_json::to_string(&output).map_err(|e| {
        napi::Error::from_reason(format!("Failed to serialize hub policy override: {}", e))
    })
}

#[napi_derive::napi]
pub fn resolve_hub_shadow_compare_config_json(metadata_json: String) -> napi::Result<String> {
    let metadata: Value = serde_json::from_str(&metadata_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse metadata JSON: {}", e)))?;
    let output = resolve_hub_shadow_compare_config(&metadata).unwrap_or(Value::Null);
    serde_json::to_string(&output).map_err(|e| {
        napi::Error::from_reason(format!(
            "Failed to serialize hub shadow compare config: {}",
            e
        ))
    })
}

#[napi_derive::napi]
pub fn resolve_apply_patch_tool_mode_from_tools_json(tools_json: String) -> napi::Result<String> {
    let tools_raw: Value = serde_json::from_str(&tools_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse tools JSON: {}", e)))?;
    let output = resolve_apply_patch_tool_mode_from_tools(&tools_raw);
    serde_json::to_string(&output).map_err(|e| {
        napi::Error::from_reason(format!(
            "Failed to serialize apply patch tool mode from tools: {}",
            e
        ))
    })
}

#[napi_derive::napi]
pub fn resolve_has_instruction_requested_passthrough_json(
    messages_json: String,
) -> napi::Result<String> {
    let messages: Value = serde_json::from_str(&messages_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse messages JSON: {}", e)))?;
    let output = resolve_has_instruction_requested_passthrough(&messages);
    serde_json::to_string(&output).map_err(|e| {
        napi::Error::from_reason(format!("Failed to serialize passthrough detection: {}", e))
    })
}

#[napi_derive::napi]
pub fn resolve_active_process_mode_json(
    base_mode_json: String,
    messages_json: String,
) -> napi::Result<String> {
    let base_mode_value: Value = serde_json::from_str(&base_mode_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse base mode JSON: {}", e)))?;
    let messages: Value = serde_json::from_str(&messages_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse messages JSON: {}", e)))?;
    let base_mode = base_mode_value.as_str().unwrap_or("chat");
    let output = resolve_active_process_mode(base_mode, &messages);
    serde_json::to_string(&output).map_err(|e| {
        napi::Error::from_reason(format!("Failed to serialize active process mode: {}", e))
    })
}

#[napi_derive::napi]
pub fn find_mappable_semantics_keys_json(metadata_json: String) -> napi::Result<String> {
    let metadata: Value = serde_json::from_str(&metadata_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse metadata JSON: {}", e)))?;
    let output = find_mappable_semantics_keys(&metadata);
    serde_json::to_string(&output).map_err(|e| {
        napi::Error::from_reason(format!(
            "Failed to serialize mappable semantics keys: {}",
            e
        ))
    })
}

#[napi_derive::napi]
pub fn build_passthrough_audit_json(
    raw_inbound_json: String,
    provider_protocol: String,
) -> napi::Result<String> {
    let raw_inbound: Value = serde_json::from_str(&raw_inbound_json).map_err(|e| {
        napi::Error::from_reason(format!("Failed to parse raw inbound JSON: {}", e))
    })?;
    let output = build_passthrough_audit(&raw_inbound, provider_protocol.trim());
    serde_json::to_string(&output).map_err(|e| {
        napi::Error::from_reason(format!("Failed to serialize passthrough audit: {}", e))
    })
}

#[napi_derive::napi]
pub fn annotate_passthrough_governance_skip_json(audit_json: String) -> napi::Result<String> {
    let audit: Value = serde_json::from_str(&audit_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse audit JSON: {}", e)))?;
    let output = annotate_passthrough_governance_skip(&audit);
    serde_json::to_string(&output).map_err(|e| {
        napi::Error::from_reason(format!(
            "Failed to serialize passthrough governance skip annotation: {}",
            e
        ))
    })
}

#[napi_derive::napi]
pub fn attach_passthrough_provider_input_audit_json(
    audit_json: String,
    provider_payload_json: String,
    provider_protocol: String,
) -> napi::Result<String> {
    let audit: Value = serde_json::from_str(&audit_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse audit JSON: {}", e)))?;
    let provider_payload: Value = serde_json::from_str(&provider_payload_json).map_err(|e| {
        napi::Error::from_reason(format!("Failed to parse provider payload JSON: {}", e))
    })?;
    let output = attach_passthrough_provider_input_audit(
        &audit,
        &provider_payload,
        provider_protocol.trim(),
    );
    serde_json::to_string(&output).map_err(|e| {
        napi::Error::from_reason(format!(
            "Failed to serialize passthrough provider input audit: {}",
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
pub fn run_req_inbound_pipeline_json(
    payload_json: String,
    protocol: String,
    endpoint: String,
) -> napi::Result<String> {
    if payload_json.trim().is_empty() {
        return Err(napi::Error::from_reason("Payload JSON is empty"));
    }

    let payload: Value = serde_json::from_str(&payload_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse payload: {}", e)))?;

    let envelope = run_req_inbound_pipeline(payload, &protocol, &endpoint)
        .map_err(|e| napi::Error::from_reason(e))?;

    serde_json::to_string(&envelope)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize envelope: {}", e)))
}

#[napi_derive::napi]
pub fn run_req_process_pipeline_json(
    envelope_json: String,
    routing_json: String,
) -> napi::Result<String> {
    let envelope: ChatEnvelope = serde_json::from_str(&envelope_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse envelope: {}", e)))?;

    let routing: RoutingDecision = serde_json::from_str(&routing_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse routing: {}", e)))?;

    let processed =
        run_req_process_pipeline(envelope, routing).map_err(|e| napi::Error::from_reason(e))?;

    serde_json::to_string(&processed)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize processed: {}", e)))
}

#[napi_derive::napi]
pub fn run_resp_outbound_pipeline_json(
    payload_json: String,
    protocol: String,
) -> napi::Result<String> {
    let payload: Value = serde_json::from_str(&payload_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse payload: {}", e)))?;

    let envelope =
        run_resp_outbound_pipeline(payload, &protocol).map_err(|e| napi::Error::from_reason(e))?;

    serde_json::to_string(&envelope)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize envelope: {}", e)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_empty_input_error() {
        let result = run_hub_pipeline_json("".to_string());
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("Input JSON is empty"));
    }

    #[test]
    fn test_invalid_json_error() {
        let result = run_hub_pipeline_json("not valid json".to_string());
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("Failed to parse input JSON"));
    }

    #[test]
    fn test_basic_pipeline_success() {
        let input = HubPipelineInput {
            request_id: "req_123".to_string(),
            endpoint: "/v1/chat".to_string(),
            entry_endpoint: "/v1/chat".to_string(),
            provider_protocol: "openai-chat".to_string(),
            payload: json!({"model": "gpt-4", "messages": [{"role": "user", "content": "hi"}]}),
            metadata: json!({"source": "test"}),
            stream: false,
            process_mode: "chat".to_string(),
            direction: "request".to_string(),
            stage: "inbound".to_string(),
        };

        let result = run_hub_pipeline(input).unwrap();
        assert!(result.success);
        assert_eq!(result.request_id, "req_123");
        assert!(result.payload.is_some());
        assert!(result.metadata.is_some());
    }

    #[test]
    fn test_protocol_resolution_aliases() {
        let test_cases = vec![
            ("openai", "openai-chat"),
            ("chat", "openai-chat"),
            ("responses", "openai-responses"),
            ("anthropic", "anthropic-messages"),
            ("gemini", "gemini-chat"),
        ];

        for (input, expected) in test_cases {
            let result = resolve_provider_protocol(input).unwrap();
            assert_eq!(
                result, expected,
                "Protocol alias {} should resolve to {}",
                input, expected
            );
        }
    }

    #[test]
    fn test_invalid_protocol_error() {
        let result = resolve_provider_protocol("invalid-protocol");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Unsupported"));
    }

    #[test]
    fn test_resolve_hub_client_protocol() {
        assert_eq!(
            resolve_hub_client_protocol("/v1/responses"),
            "openai-responses"
        );
        assert_eq!(
            resolve_hub_client_protocol("/v1/messages"),
            "anthropic-messages"
        );
        assert_eq!(
            resolve_hub_client_protocol("/v1/chat/completions"),
            "openai-chat"
        );
    }

    #[test]
    fn test_resolve_outbound_stream_intent() {
        assert_eq!(resolve_outbound_stream_intent(&json!("always")), Some(true));
        assert_eq!(resolve_outbound_stream_intent(&json!("never")), Some(false));
        assert_eq!(resolve_outbound_stream_intent(&json!("auto")), None);
    }

    #[test]
    fn test_apply_outbound_stream_preference_sets_and_unsets_stream_fields() {
        let request = json!({
            "parameters": { "temperature": 0.2 },
            "metadata": { "x": 1 }
        });
        let with_stream = apply_outbound_stream_preference(&request, Some(true), Some("chat"));
        assert_eq!(
            with_stream
                .get("parameters")
                .and_then(|v| v.get("stream"))
                .and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(
            with_stream
                .get("metadata")
                .and_then(|v| v.get("outboundStream"))
                .and_then(|v| v.as_bool()),
            Some(true)
        );

        let unset_stream = apply_outbound_stream_preference(&with_stream, None, Some("chat"));
        assert!(unset_stream
            .get("parameters")
            .and_then(|v| v.get("stream"))
            .is_none());
        assert!(unset_stream
            .get("metadata")
            .and_then(|v| v.get("outboundStream"))
            .is_none());
    }

    #[test]
    fn test_apply_outbound_stream_preference_passthrough_keeps_request_when_stream_undefined() {
        let request = json!({
            "parameters": { "temperature": 0.2 },
            "metadata": { "x": 1 }
        });
        let output = apply_outbound_stream_preference(&request, None, Some("passthrough"));
        assert_eq!(output, request);
    }

    #[test]
    fn test_null_payload_error() {
        let result = run_req_inbound_pipeline(Value::Null, "openai-chat", "/v1/chat");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("cannot be null"));
    }

    #[test]
    fn test_empty_messages_error() {
        let envelope = ChatEnvelope {
            messages: vec![],
            semantics: None,
            metadata: None,
        };
        let routing = RoutingDecision {
            provider_key: "openai.default".to_string(),
            target_endpoint: "/v1/chat".to_string(),
            metadata: None,
        };

        let result = run_req_process_pipeline(envelope, routing);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("at least one message"));
    }

    #[test]
    fn test_req_inbound_pipeline_success() {
        let payload = json!({"model": "gpt-4"});
        let result = run_req_inbound_pipeline(payload, "openai-chat", "/v1/chat").unwrap();
        assert_eq!(result.protocol, "openai-chat");
        assert!(result.metadata.is_some());
    }

    #[test]
    fn test_req_process_pipeline_success() {
        let envelope = ChatEnvelope {
            messages: vec![json!({"role": "user", "content": "hello"})],
            semantics: Some(json!({})),
            metadata: Some(json!({"test": true})),
        };
        let routing = RoutingDecision {
            provider_key: "openai.default".to_string(),
            target_endpoint: "/v1/chat".to_string(),
            metadata: Some(json!({"region": "us"})),
        };

        let result = run_req_process_pipeline(envelope, routing).unwrap();
        assert!(result.request.get("messages").is_some());
        assert_eq!(result.routing.provider_key, "openai.default");
    }

    #[test]
    fn test_resp_outbound_pipeline_success() {
        let payload = json!({"choices": [{"message": {"role": "assistant", "content": "Hello"}}]});
        let result = run_resp_outbound_pipeline(payload, "openai-chat").unwrap();
        assert_eq!(result.protocol, "openai-chat");
        assert!(result.payload.get("choices").is_some());
    }

    #[test]
    fn test_normalize_endpoint() {
        assert_eq!(normalize_endpoint(""), "/v1/chat/completions");
        assert_eq!(normalize_endpoint("/v1/chat"), "/v1/chat");
        assert_eq!(normalize_endpoint("v1/chat"), "/v1/chat");
    }

    #[test]
    fn test_json_roundtrip() {
        let input_json = json!({
            "requestId": "req_456",
            "endpoint": "/v1/chat",
            "entryEndpoint": "/v1/chat",
            "providerProtocol": "anthropic-messages",
            "payload": {"model": "claude-3", "messages": []},
            "metadata": {"test": true},
            "stream": true,
            "processMode": "chat",
            "direction": "request",
            "stage": "inbound"
        })
        .to_string();

        let result = run_hub_pipeline_json(input_json).unwrap();
        let output: HubPipelineOutput = serde_json::from_str(&result).unwrap();
        assert!(output.success);
        assert_eq!(output.request_id, "req_456");
    }

    #[test]
    fn test_resolve_stop_message_router_metadata_prefers_client_tmux_and_sets_aliases() {
        let metadata = json!({
            "stopMessageClientInjectSessionScope": "  scope-123  ",
            "stopMessageClientInjectScope": " tmux:abc ",
            "clientTmuxSessionId": " client-tmux-1 ",
            "tmuxSessionId": "fallback-tmux"
        });
        let output = resolve_stop_message_router_metadata(&metadata);
        let row = output.as_object().expect("object output");
        assert_eq!(
            row.get("stopMessageClientInjectSessionScope")
                .and_then(|v| v.as_str()),
            Some("scope-123")
        );
        assert_eq!(
            row.get("stopMessageClientInjectScope")
                .and_then(|v| v.as_str()),
            Some("tmux:abc")
        );
        assert_eq!(
            row.get("clientTmuxSessionId").and_then(|v| v.as_str()),
            Some("client-tmux-1")
        );
        assert_eq!(
            row.get("client_tmux_session_id").and_then(|v| v.as_str()),
            Some("client-tmux-1")
        );
        assert_eq!(
            row.get("tmuxSessionId").and_then(|v| v.as_str()),
            Some("client-tmux-1")
        );
        assert_eq!(
            row.get("tmux_session_id").and_then(|v| v.as_str()),
            Some("client-tmux-1")
        );
    }

    #[test]
    fn test_resolve_stop_message_router_metadata_empty_input_returns_empty_object() {
        let output = resolve_stop_message_router_metadata(&json!(null));
        let row = output.as_object().expect("object output");
        assert!(row.is_empty());
    }

    #[test]
    fn test_extract_adapter_context_metadata_fields_trims_strings_and_keeps_booleans() {
        let metadata = json!({
            "clockDaemonId": "  daemon-1 ",
            "clientInjectReady": true,
            "workdir": "   ",
            "ignored": 123
        });
        let keys = json!([
            "clockDaemonId",
            "clientInjectReady",
            "workdir",
            "missing",
            1
        ]);
        let output = extract_adapter_context_metadata_fields(&metadata, &keys);
        let row = output.as_object().expect("object output");
        assert_eq!(
            row.get("clockDaemonId").and_then(|v| v.as_str()),
            Some("daemon-1")
        );
        assert_eq!(
            row.get("clientInjectReady").and_then(|v| v.as_bool()),
            Some(true)
        );
        assert!(!row.contains_key("workdir"));
        assert!(!row.contains_key("missing"));
    }

    #[test]
    fn test_resolve_hub_policy_override_valid() {
        let metadata = json!({
            "__hubPolicyOverride": {
                "mode": " Observe ",
                "sampleRate": 0.5
            }
        });
        let output = resolve_hub_policy_override(&metadata).expect("policy override");
        let row = output.as_object().expect("object output");
        assert_eq!(row.get("mode").and_then(|v| v.as_str()), Some("observe"));
        assert_eq!(row.get("sampleRate").and_then(|v| v.as_f64()), Some(0.5));
    }

    #[test]
    fn test_resolve_hub_policy_override_invalid_mode_returns_none() {
        let metadata = json!({
            "__hubPolicyOverride": {
                "mode": "invalid"
            }
        });
        let output = resolve_hub_policy_override(&metadata);
        assert!(output.is_none());
    }

    #[test]
    fn test_resolve_hub_shadow_compare_mode_fallback() {
        let metadata = json!({
            "__hubShadowCompare": {
                "mode": " enforce "
            }
        });
        let output = resolve_hub_shadow_compare_config(&metadata).expect("shadow compare");
        let row = output.as_object().expect("object output");
        assert_eq!(
            row.get("baselineMode").and_then(|v| v.as_str()),
            Some("enforce")
        );
    }

    #[test]
    fn test_resolve_hub_shadow_compare_invalid_returns_none() {
        let metadata = json!({
            "__hubShadowCompare": {
                "baselineMode": "x"
            }
        });
        let output = resolve_hub_shadow_compare_config(&metadata);
        assert!(output.is_none());
    }

    #[test]
    fn test_resolve_apply_patch_tool_mode_from_tools_freeform() {
        let tools = json!([
            {
                "type": "function",
                "function": { "name": "apply_patch", "format": "freeform" }
            }
        ]);
        let mode = resolve_apply_patch_tool_mode_from_tools(&tools);
        assert_eq!(mode.as_deref(), Some("freeform"));
    }

    #[test]
    fn test_resolve_apply_patch_tool_mode_from_tools_defaults_to_schema() {
        let tools = json!([
            {
                "type": "function",
                "function": { "name": "apply_patch" }
            }
        ]);
        let mode = resolve_apply_patch_tool_mode_from_tools(&tools);
        assert_eq!(mode.as_deref(), Some("schema"));
    }

    #[test]
    fn test_resolve_apply_patch_tool_mode_from_tools_non_matching_returns_none() {
        let tools = json!([
            {
                "type": "function",
                "function": { "name": "exec_command" }
            }
        ]);
        let mode = resolve_apply_patch_tool_mode_from_tools(&tools);
        assert!(mode.is_none());
    }

    #[test]
    fn test_resolve_has_instruction_requested_passthrough_true_for_named_target() {
        let messages = json!([
            {
                "role": "user",
                "content": "<**sticky:tabglm.key1.glm-5:passthrough**>"
            }
        ]);
        assert!(resolve_has_instruction_requested_passthrough(&messages));
    }

    #[test]
    fn test_resolve_has_instruction_requested_passthrough_ignores_historical_user_message() {
        let messages = json!([
            {
                "role": "user",
                "content": "<**sticky:tabglm.key1.glm-5:passthrough**>"
            },
            {
                "role": "assistant",
                "content": "ack"
            }
        ]);
        assert!(!resolve_has_instruction_requested_passthrough(&messages));
    }

    #[test]
    fn test_resolve_has_instruction_requested_passthrough_ignores_code_block_marker() {
        let messages = json!([
            {
                "role": "user",
                "content": "```txt\n<**sticky:tabglm.key1.glm-5:passthrough**>\n```"
            }
        ]);
        assert!(!resolve_has_instruction_requested_passthrough(&messages));
    }

    #[test]
    fn test_resolve_active_process_mode_prefers_passthrough_base_mode() {
        let messages = json!([
            {
                "role": "user",
                "content": "normal text"
            }
        ]);
        assert_eq!(
            resolve_active_process_mode("passthrough", &messages),
            "passthrough"
        );
    }

    #[test]
    fn test_resolve_active_process_mode_activates_passthrough_from_instruction() {
        let messages = json!([
            {
                "role": "user",
                "content": "<**sticky:tabglm.key1.glm-5:passthrough**>"
            }
        ]);
        assert_eq!(
            resolve_active_process_mode("chat", &messages),
            "passthrough"
        );
    }

    #[test]
    fn test_find_mappable_semantics_keys_collects_only_present_keys() {
        let metadata = json!({
            "responses_resume": [],
            "extraFields": {"x": 1},
            "safe": true
        });
        let keys = find_mappable_semantics_keys(&metadata);
        assert_eq!(
            keys,
            vec!["responses_resume".to_string(), "extraFields".to_string()]
        );
    }

    #[test]
    fn test_build_passthrough_audit_collects_non_canonical_keys_sorted() {
        let raw = json!({
            "messages": [],
            "model": "m",
            "zeta": true,
            "alpha": 1
        });
        let output = build_passthrough_audit(&raw, "openai-chat");
        let keys = output
            .get("todo")
            .and_then(|v| v.get("inbound"))
            .and_then(|v| v.get("unmappedTopLevelKeys"))
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        assert_eq!(keys, vec![json!("alpha"), json!("zeta")]);
    }

    #[test]
    fn test_annotate_passthrough_governance_skip_sets_governance_marker() {
        let audit = json!({ "raw": { "inbound": {} } });
        let output = annotate_passthrough_governance_skip(&audit);
        assert_eq!(
            output
                .get("todo")
                .and_then(|v| v.get("governance"))
                .and_then(|v| v.get("skipped"))
                .and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(
            output
                .get("todo")
                .and_then(|v| v.get("governance"))
                .and_then(|v| v.get("reason"))
                .and_then(|v| v.as_str()),
            Some("process_mode_passthrough")
        );
    }

    #[test]
    fn test_attach_passthrough_provider_input_audit_sets_provider_input_and_outbound_todo() {
        let audit = json!({
            "raw": { "inbound": { "messages": [] } },
            "todo": { "inbound": { "unmappedTopLevelKeys": [] } }
        });
        let provider_payload = json!({
            "messages": [],
            "custom_field": "x"
        });
        let output = attach_passthrough_provider_input_audit(
            &audit,
            &provider_payload,
            "anthropic-messages",
        );
        assert_eq!(
            output
                .get("raw")
                .and_then(|v| v.get("providerInput"))
                .and_then(|v| v.get("custom_field"))
                .and_then(|v| v.as_str()),
            Some("x")
        );
        let outbound_keys = output
            .get("todo")
            .and_then(|v| v.get("outbound"))
            .and_then(|v| v.get("unmappedTopLevelKeys"))
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        assert_eq!(outbound_keys, vec![json!("custom_field")]);
        assert_eq!(
            output
                .get("todo")
                .and_then(|v| v.get("outbound"))
                .and_then(|v| v.get("providerProtocol"))
                .and_then(|v| v.as_str()),
            Some("anthropic-messages")
        );
    }

    #[test]
    fn test_error_output_structure() {
        let result = run_hub_pipeline_json("not json".to_string());
        assert!(result.is_err());
    }
}
