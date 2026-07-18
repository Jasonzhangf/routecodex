//! Pure Rust provider compatibility profile core.
//!
//! This crate is intentionally NAPI-free so V3 runtime/CLI can link it without
//! Node symbols. The profile ids and behavior are carried from the existing
//! `req_outbound_stage3_compat` Rust profile surface used by V2.

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Number, Value};
use sha2::{Digest, Sha256};
use std::time::{SystemTime, UNIX_EPOCH};

// feature_id: v3.provider_compat_profile_loading

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterContext {
    #[serde(default)]
    pub compatibility_profile: Option<String>,
    #[serde(default)]
    pub provider_protocol: Option<String>,
    #[serde(default)]
    pub request_id: Option<String>,
    #[serde(default)]
    pub entry_endpoint: Option<String>,
    #[serde(default)]
    pub route_id: Option<String>,
    #[serde(default, rename = "__rt")]
    pub rt: Option<Value>,
    #[serde(default)]
    pub captured_chat_request: Option<Value>,
    #[serde(default)]
    pub deepseek: Option<Value>,
    #[serde(default)]
    pub anthropic_thinking: Option<String>,
    #[serde(default)]
    pub estimated_input_tokens: Option<f64>,
    #[serde(default)]
    pub model_id: Option<String>,
    #[serde(default)]
    pub client_model_id: Option<String>,
    #[serde(default)]
    pub original_model_id: Option<String>,
    #[serde(default)]
    pub provider_id: Option<String>,
    #[serde(default)]
    pub provider_key: Option<String>,
    #[serde(default)]
    pub runtime_key: Option<String>,
    #[serde(default)]
    pub client_request_id: Option<String>,
    #[serde(default)]
    pub group_request_id: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub conversation_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReqOutboundCompatInput {
    pub payload: Value,
    pub adapter_context: AdapterContext,
    #[serde(default)]
    pub explicit_profile: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompatResult {
    pub payload: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub applied_profile: Option<String>,
    pub native_applied: bool,
}

pub mod req_outbound_stage3_compat {
    pub use super::{
        run_req_outbound_stage3_compat, run_resp_inbound_stage3_compat, AdapterContext,
        CompatResult, ReqOutboundCompatInput,
    };
}

pub fn run_req_outbound_stage3_compat(
    input: ReqOutboundCompatInput,
) -> Result<CompatResult, String> {
    let profile = pick_compat_profile(&input);
    let ReqOutboundCompatInput {
        payload: input_payload,
        adapter_context,
        ..
    } = input;

    let mut payload = input_payload;
    if provider_protocol_matches(
        adapter_context.provider_protocol.as_ref(),
        "openai-responses",
    ) {
        if let Some(root) = payload.as_object_mut() {
            normalize_responses_function_tools(root);
            strip_responses_reasoning_content_for_provider_wire(root);
        }
    }

    let Some(profile_id) = profile.as_deref() else {
        return Ok(build_compat_result(payload, None));
    };

    if is_responses_crs_profile(profile_id) {
        if provider_protocol_matches(
            adapter_context.provider_protocol.as_ref(),
            "openai-responses",
        ) {
            if let Some(root) = payload.as_object_mut() {
                apply_responses_crs_request_compat(root);
            }
            return Ok(CompatResult {
                payload,
                applied_profile: Some(profile_id.to_string()),
                native_applied: true,
            });
        }
        return Ok(build_compat_result(payload, None));
    }

    if is_minimax_profile(profile_id) {
        return Ok(CompatResult {
            payload,
            applied_profile: Some(profile_id.to_string()),
            native_applied: true,
        });
    }

    if is_lmstudio_profile(profile_id) {
        if let Some(root) = payload.as_object_mut() {
            apply_lmstudio_request_compat(root, &adapter_context);
        }
        return Ok(CompatResult {
            payload,
            applied_profile: Some(profile_id.to_string()),
            native_applied: true,
        });
    }

    if is_glm_profile(profile_id) {
        if provider_protocol_matches(adapter_context.provider_protocol.as_ref(), "openai-chat") {
            return Ok(CompatResult {
                payload: apply_glm_request_compat(payload),
                applied_profile: Some(profile_id.to_string()),
                native_applied: true,
            });
        }
        return Ok(build_compat_result(payload, None));
    }

    if is_gemini_profile(profile_id) {
        if provider_protocol_matches(adapter_context.provider_protocol.as_ref(), "gemini-chat") {
            return Ok(CompatResult {
                payload: apply_gemini_request_compat(payload, &adapter_context),
                applied_profile: Some(profile_id.to_string()),
                native_applied: true,
            });
        }
        return Ok(build_compat_result(payload, None));
    }

    if is_single_tool_call_history_profile(profile_id) {
        if provider_protocol_matches(adapter_context.provider_protocol.as_ref(), "openai-chat") {
            if let Some(root) = payload.as_object_mut() {
                split_parallel_tool_call_assistant_history(root);
            }
            return Ok(CompatResult {
                payload,
                applied_profile: Some(profile_id.to_string()),
                native_applied: true,
            });
        }
        return Ok(build_compat_result(payload, None));
    }

    Ok(build_compat_result(payload, None))
}

pub fn run_resp_inbound_stage3_compat(
    input: ReqOutboundCompatInput,
) -> Result<CompatResult, String> {
    let profile = pick_compat_profile(&input);
    let Some(profile_id) = profile.as_deref() else {
        return Ok(build_compat_result(input.payload, None));
    };

    if is_gemini_profile(profile_id) {
        if provider_protocol_matches(
            input.adapter_context.provider_protocol.as_ref(),
            "gemini-chat",
        ) {
            return Ok(CompatResult {
                payload: input.payload,
                applied_profile: Some(profile_id.to_string()),
                native_applied: true,
            });
        }
        return Ok(build_compat_result(input.payload, None));
    }

    if is_minimax_profile(profile_id) {
        if provider_protocol_matches(
            input.adapter_context.provider_protocol.as_ref(),
            "openai-responses",
        ) || provider_protocol_matches(
            input.adapter_context.provider_protocol.as_ref(),
            "openai-chat",
        ) {
            return Ok(CompatResult {
                payload: harvest_text_tool_calls(input.payload)?,
                applied_profile: Some(profile_id.to_string()),
                native_applied: true,
            });
        }
        return Ok(build_compat_result(input.payload, None));
    }

    if is_lmstudio_profile(profile_id) {
        return Ok(CompatResult {
            payload: apply_lmstudio_response_compat(
                input.payload,
                input.adapter_context.request_id.as_ref(),
            ),
            applied_profile: Some(profile_id.to_string()),
            native_applied: true,
        });
    }

    if is_glm_profile(profile_id) {
        if provider_protocol_matches(
            input.adapter_context.provider_protocol.as_ref(),
            "openai-chat",
        ) {
            return Ok(CompatResult {
                payload: apply_glm_response_compat(input.payload),
                applied_profile: Some(profile_id.to_string()),
                native_applied: true,
            });
        }
        return Ok(build_compat_result(input.payload, None));
    }

    Ok(build_compat_result(input.payload, None))
}

fn strip_top_level_provider_internal_fields(payload: Value) -> Value {
    let Some(mut root) = payload.as_object().cloned() else {
        return payload;
    };
    root.remove("semantics");
    root.remove("processed");
    root.remove("processingMetadata");
    Value::Object(root)
}

fn normalize_profile(profile: Option<&String>) -> Option<String> {
    profile
        .map(|profile| profile.trim())
        .filter(|profile| !profile.is_empty())
        .map(str::to_ascii_lowercase)
}

fn pick_compat_profile(input: &ReqOutboundCompatInput) -> Option<String> {
    normalize_profile(input.explicit_profile.as_ref())
        .or_else(|| normalize_profile(input.adapter_context.compatibility_profile.as_ref()))
}

fn build_compat_result(payload: Value, profile: Option<String>) -> CompatResult {
    CompatResult {
        payload: strip_top_level_provider_internal_fields(payload),
        applied_profile: profile,
        native_applied: true,
    }
}

fn profile_matches(profile: &str, expected: &str) -> bool {
    profile.trim().eq_ignore_ascii_case(expected)
}

fn is_minimax_profile(profile: &str) -> bool {
    profile_matches(profile, "chat:minimax")
}

fn is_responses_crs_profile(profile: &str) -> bool {
    profile_matches(profile, "responses:crs")
}

fn is_lmstudio_profile(profile: &str) -> bool {
    profile_matches(profile, "chat:lmstudio") || profile_matches(profile, "responses:lmstudio")
}

fn is_gemini_profile(profile: &str) -> bool {
    profile_matches(profile, "chat:gemini")
}

fn is_glm_profile(profile: &str) -> bool {
    profile_matches(profile, "chat:glm")
}

fn is_single_tool_call_history_profile(profile: &str) -> bool {
    profile_matches(profile, "chat:single-tool-call-history")
        || profile_matches(profile, "openai-chat:single-tool-call-history")
}

fn provider_protocol_matches(protocol: Option<&String>, expected: &str) -> bool {
    match protocol {
        Some(value) => value.trim().eq_ignore_ascii_case(expected),
        None => false,
    }
}

fn normalize_responses_tool_parameters(raw: Option<&Value>) -> Value {
    let mut candidate = raw.cloned().unwrap_or(Value::Null);
    if let Value::String(text) = &candidate {
        candidate = serde_json::from_str::<Value>(text)
            .ok()
            .unwrap_or_else(|| Value::Object(Map::new()));
    }
    if let Value::Object(_) = candidate {
        return candidate;
    }
    json!({
        "type": "object",
        "properties": {},
        "additionalProperties": true
    })
}

fn normalize_responses_function_tools(root: &mut Map<String, Value>) {
    let Some(raw_tools) = root.get("tools").and_then(Value::as_array) else {
        return;
    };
    let mut normalized = Vec::new();
    for entry in raw_tools {
        let Some(tool_obj) = entry.as_object() else {
            normalized.push(entry.clone());
            continue;
        };
        if tool_obj.get("type").and_then(Value::as_str).map(str::trim) != Some("function") {
            normalized.push(entry.clone());
            continue;
        }
        let function_obj = tool_obj.get("function").and_then(Value::as_object);
        let name = tool_obj
            .get("name")
            .and_then(Value::as_str)
            .or_else(|| {
                function_obj
                    .and_then(|row| row.get("name"))
                    .and_then(Value::as_str)
            })
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let Some(name) = name else {
            normalized.push(entry.clone());
            continue;
        };
        let mut normalized_tool = Map::new();
        normalized_tool.insert("type".to_string(), Value::String("function".to_string()));
        normalized_tool.insert("name".to_string(), Value::String(name.to_string()));
        if let Some(description) = tool_obj
            .get("description")
            .and_then(Value::as_str)
            .or_else(|| {
                function_obj
                    .and_then(|row| row.get("description"))
                    .and_then(Value::as_str)
            })
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            normalized_tool.insert(
                "description".to_string(),
                Value::String(description.to_string()),
            );
        }
        normalized_tool.insert(
            "parameters".to_string(),
            normalize_responses_tool_parameters(
                tool_obj
                    .get("parameters")
                    .or_else(|| function_obj.and_then(|row| row.get("parameters"))),
            ),
        );
        normalized.push(Value::Object(normalized_tool));
    }
    root.insert("tools".to_string(), Value::Array(normalized));
}

fn strip_responses_reasoning_content_for_provider_wire(root: &mut Map<String, Value>) {
    let Some(input) = root.get_mut("input").and_then(Value::as_array_mut) else {
        return;
    };
    for entry in input.iter_mut() {
        let Some(row) = entry.as_object_mut() else {
            continue;
        };
        if row.get("type").and_then(Value::as_str) == Some("reasoning") {
            row.remove("content");
        }
    }
}

fn apply_responses_crs_request_compat(root: &mut Map<String, Value>) {
    normalize_responses_function_tools(root);
    root.remove("temperature");
}

fn split_parallel_tool_call_assistant_history(root: &mut Map<String, Value>) -> bool {
    let Some(messages) = root.get("messages").and_then(Value::as_array) else {
        return false;
    };
    let mut changed = false;
    let mut next_messages = Vec::with_capacity(messages.len());
    for message in messages {
        let Some(message_obj) = message.as_object() else {
            next_messages.push(message.clone());
            continue;
        };
        if message_obj.get("role").and_then(Value::as_str) != Some("assistant") {
            next_messages.push(message.clone());
            continue;
        }
        let Some(tool_calls) = message_obj.get("tool_calls").and_then(Value::as_array) else {
            next_messages.push(message.clone());
            continue;
        };
        if tool_calls.len() <= 1 {
            next_messages.push(message.clone());
            continue;
        }
        changed = true;
        for (index, tool_call) in tool_calls.iter().enumerate() {
            let mut split_message = message_obj.clone();
            split_message.insert(
                "tool_calls".to_string(),
                Value::Array(vec![tool_call.clone()]),
            );
            if index > 0 && message_obj.contains_key("content") {
                split_message.insert("content".to_string(), Value::Null);
            }
            next_messages.push(Value::Object(split_message));
        }
    }
    if changed {
        root.insert("messages".to_string(), Value::Array(next_messages));
    }
    changed
}

const GEMINI_ALLOW_TOP_LEVEL: [&str; 12] = [
    "model",
    "project",
    "request",
    "requestId",
    "requestType",
    "userAgent",
    "contents",
    "systemInstruction",
    "tools",
    "generationConfig",
    "safetySettings",
    "toolConfig",
];

fn is_search_route(adapter_context: &AdapterContext) -> bool {
    let route_id = adapter_context
        .route_id
        .as_ref()
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_default();
    ["web_search", "search"]
        .iter()
        .any(|prefix| route_id.starts_with(prefix))
}

fn apply_claude_thinking_tool_schema_compat(payload: Value) -> Value {
    let Some(root) = payload.as_object() else {
        return payload;
    };
    let model = root
        .get("model")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    if !model.starts_with("claude-") {
        return Value::Object(root.clone());
    }
    let mut next_root = root.clone();
    let request_is_object = next_root
        .get("request")
        .and_then(Value::as_object)
        .is_some();
    let tools = if request_is_object {
        next_root
            .get("request")
            .and_then(Value::as_object)
            .and_then(|request| request.get("tools"))
            .and_then(Value::as_array)
            .cloned()
    } else {
        next_root.get("tools").and_then(Value::as_array).cloned()
    };
    let Some(tools) = tools else {
        return Value::Object(next_root);
    };
    let mut next_tools = Vec::new();
    for entry in tools {
        let Some(entry_obj) = entry.as_object() else {
            next_tools.push(entry);
            continue;
        };
        let Some(decls) = entry_obj
            .get("functionDeclarations")
            .and_then(Value::as_array)
            .cloned()
        else {
            next_tools.push(Value::Object(entry_obj.clone()));
            continue;
        };
        let mut next_decls = Vec::new();
        for decl in decls {
            let Some(decl_obj) = decl.as_object() else {
                next_decls.push(decl);
                continue;
            };
            let mut next_decl = decl_obj.clone();
            next_decl.insert(
                "parameters".to_string(),
                json!({"type":"object","properties":{},"additionalProperties":true}),
            );
            next_decl.remove("strict");
            next_decls.push(Value::Object(next_decl));
        }
        next_tools.push(json!({ "functionDeclarations": next_decls }));
    }
    if request_is_object {
        if let Some(request) = next_root.get_mut("request").and_then(Value::as_object_mut) {
            request.insert("tools".to_string(), Value::Array(next_tools));
        }
    } else {
        next_root.insert("tools".to_string(), Value::Array(next_tools));
    }
    Value::Object(next_root)
}

fn apply_gemini_web_search_request_compat(
    payload: Value,
    adapter_context: &AdapterContext,
) -> Value {
    if !is_search_route(adapter_context) {
        return payload;
    }
    let Some(root) = payload.as_object() else {
        return payload;
    };
    let mut next = root.clone();
    next.remove("web_search");
    let tools_rows = next.get("tools").and_then(Value::as_array);
    let Some(tools_rows) = tools_rows else {
        next.insert("tools".to_string(), json!([{ "googleSearch": {} }]));
        return Value::Object(next);
    };
    let mut next_tools = Vec::new();
    for entry in tools_rows {
        let Some(entry_obj) = entry.as_object() else {
            continue;
        };
        let decls = entry_obj
            .get("functionDeclarations")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let web_search_decls: Vec<Value> = decls
            .into_iter()
            .filter(|decl| {
                decl.as_object()
                    .and_then(|decl_obj| read_trimmed_string(decl_obj.get("name")))
                    .map(|name| name.eq_ignore_ascii_case("web_search"))
                    .unwrap_or(false)
            })
            .collect();
        if !web_search_decls.is_empty() {
            next_tools.push(json!({ "functionDeclarations": web_search_decls }));
            continue;
        }
        if let Some(google_search) = entry_obj.get("googleSearch").and_then(Value::as_object) {
            next_tools.push(json!({ "googleSearch": google_search }));
        }
    }
    if next_tools.is_empty() {
        next.insert("tools".to_string(), json!([{ "googleSearch": {} }]));
    } else {
        next.insert("tools".to_string(), Value::Array(next_tools));
    }
    Value::Object(next)
}

fn apply_gemini_shallow_pick(payload: Value) -> Value {
    let Some(root) = payload.as_object() else {
        return payload;
    };
    let mut next = Map::new();
    for key in GEMINI_ALLOW_TOP_LEVEL {
        if let Some(value) = root.get(key) {
            next.insert(key.to_string(), value.clone());
        }
    }
    Value::Object(next)
}

fn apply_gemini_request_compat(payload: Value, adapter_context: &AdapterContext) -> Value {
    let payload = apply_claude_thinking_tool_schema_compat(payload);
    let payload = apply_gemini_web_search_request_compat(payload, adapter_context);
    apply_gemini_shallow_pick(payload)
}

fn apply_glm_request_compat(payload: Value) -> Value {
    let mut payload = payload;
    let Some(root) = payload.as_object_mut() else {
        return payload;
    };
    apply_glm_web_search_request_transform(root);
    apply_glm_auto_thinking(root);
    payload
}

fn apply_glm_web_search_request_transform(root: &mut Map<String, Value>) {
    let Some(web_search) = root.get("web_search").and_then(Value::as_object).cloned() else {
        return;
    };
    let query = web_search
        .get("query")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    root.remove("web_search");
    let Some(query) = query else {
        return;
    };
    let mut web_search_config = Map::new();
    web_search_config.insert(
        "search_engine".to_string(),
        Value::String("search_std".to_string()),
    );
    web_search_config.insert("enable".to_string(), Value::Bool(true));
    web_search_config.insert("search_query".to_string(), Value::String(query));
    web_search_config.insert("search_result".to_string(), Value::Bool(true));
    if let Some(recency) = web_search
        .get("recency")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        web_search_config.insert(
            "search_recency_filter".to_string(),
            Value::String(recency.to_string()),
        );
    }
    if let Some(count) = web_search
        .get("count")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .map(|value| value.floor() as i64)
        .filter(|value| *value >= 1 && *value <= 50)
    {
        web_search_config.insert("count".to_string(), Value::Number(Number::from(count)));
    }
    root.insert(
        "tools".to_string(),
        json!([{ "type": "web_search", "web_search": Value::Object(web_search_config) }]),
    );
}

fn apply_glm_auto_thinking(root: &mut Map<String, Value>) {
    let model_id = root
        .get("model")
        .and_then(Value::as_str)
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if model_id.starts_with("glm-4.6v") {
        return;
    }
    if !["glm-4.7", "glm-4.6", "glm-4.5", "glm-z1"]
        .iter()
        .any(|prefix| model_id.starts_with(prefix))
    {
        return;
    }
    if root.get("thinking").and_then(Value::as_object).is_none() {
        root.insert("thinking".to_string(), json!({ "type": "enabled" }));
    }
}

fn apply_lmstudio_request_compat(root: &mut Map<String, Value>, _adapter_context: &AdapterContext) {
    normalize_lmstudio_tool_call_ids(root);
}

fn current_unix_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs() as i64)
        .unwrap_or(0)
}

fn current_unix_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as i64)
        .unwrap_or(0)
}

fn ensure_default_field(root: &mut Map<String, Value>, key: &str, value: Value) {
    if root.get(key).is_none() {
        root.insert(key.to_string(), value);
    }
}

fn apply_lmstudio_response_defaults(root: &mut Map<String, Value>) {
    ensure_default_field(root, "object", Value::String("chat.completion".to_string()));
    ensure_default_field(
        root,
        "id",
        Value::String(format!(
            "chatcmpl_{}_{}",
            current_unix_millis(),
            uuid::Uuid::new_v4()
                .to_string()
                .replace('-', "")
                .chars()
                .take(8)
                .collect::<String>()
        )),
    );
    ensure_default_field(
        root,
        "created",
        Value::Number(Number::from(current_unix_seconds())),
    );
    ensure_default_field(root, "model", Value::String("unknown".to_string()));
}

fn find_balanced_json_end(text: &str, start: usize) -> Option<usize> {
    let bytes = text.as_bytes();
    if start >= bytes.len() || bytes[start] != b'{' {
        return None;
    }
    let mut depth = 0i32;
    let mut in_string = false;
    let mut escape = false;
    for (offset, ch) in text[start..].char_indices() {
        if in_string {
            if escape {
                escape = false;
            } else if ch == '\\' {
                escape = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }
        match ch {
            '"' => in_string = true,
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(start + offset + ch.len_utf8());
                }
            }
            _ => {}
        }
    }
    None
}

fn recover_qwen_style_tool_tokens_from_text(text: &str) -> Vec<Value> {
    if !text.contains("<|tool_calls_section_begin|>") {
        return Vec::new();
    }
    let Ok(call_re) = Regex::new(
        r"(?is)<\|tool_call_begin\|>\s*(?:functions\.)?([A-Za-z_][A-Za-z0-9_.-]*)(?::\d+)?\s*<\|tool_call_argument_begin\|>",
    ) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for caps in call_re.captures_iter(text) {
        let Some(full) = caps.get(0) else {
            continue;
        };
        let Some(name) = caps
            .get(1)
            .map(|value| value.as_str().trim())
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        let mut args_start = full.end();
        while args_start < text.len() && text.as_bytes()[args_start].is_ascii_whitespace() {
            args_start += 1;
        }
        let Some(args_end) = find_balanced_json_end(text, args_start) else {
            continue;
        };
        let args = text[args_start..args_end].trim();
        let args_value = serde_json::from_str::<Value>(args).unwrap_or_else(|_| json!({}));
        out.push(json!({
            "id": format!("call_{}", out.len() + 1),
            "type": "function",
            "function": {
                "name": name,
                "arguments": serde_json::to_string(&args_value).unwrap_or_else(|_| "{}".to_string())
            }
        }));
    }
    out
}

fn normalize_lmstudio_tool_call_ids(root: &mut Map<String, Value>) {
    let Some(choices) = root.get_mut("choices").and_then(Value::as_array_mut) else {
        return;
    };
    let mut counter = 0usize;
    for choice in choices {
        let Some(message) = choice.get_mut("message").and_then(Value::as_object_mut) else {
            continue;
        };
        let Some(tool_calls) = message.get_mut("tool_calls").and_then(Value::as_array_mut) else {
            continue;
        };
        for call in tool_calls {
            let Some(call_obj) = call.as_object_mut() else {
                continue;
            };
            counter += 1;
            let id = read_trimmed_string(call_obj.get("id"))
                .or_else(|| read_trimmed_string(call_obj.get("call_id")))
                .unwrap_or_else(|| format!("call_{}", counter));
            call_obj.insert("id".to_string(), Value::String(id.clone()));
            call_obj.insert("call_id".to_string(), Value::String(id));
        }
    }
}

fn harvest_lmstudio_chat_tool_calls(root: &mut Map<String, Value>) {
    let Some(choices) = root.get_mut("choices").and_then(Value::as_array_mut) else {
        return;
    };
    for choice in choices {
        let Some(choice_obj) = choice.as_object_mut() else {
            continue;
        };
        let text = choice_obj
            .get("message")
            .and_then(Value::as_object)
            .and_then(|message| read_trimmed_string(message.get("content")))
            .unwrap_or_default();
        if text.is_empty() {
            continue;
        }
        let mut calls = recover_qwen_style_tool_tokens_from_text(&text);
        if calls.is_empty() {
            calls = parse_text_tool_calls(&text)
                .into_iter()
                .enumerate()
                .map(|(idx, call)| chat_tool_call_from_parsed(call, idx + 1))
                .collect();
        }
        if calls.is_empty() {
            continue;
        }
        if let Some(message) = choice_obj.get_mut("message").and_then(Value::as_object_mut) {
            message.insert("tool_calls".to_string(), Value::Array(calls));
            message.insert("content".to_string(), Value::Null);
        }
        choice_obj.insert(
            "finish_reason".to_string(),
            Value::String("tool_calls".to_string()),
        );
    }
}

fn apply_lmstudio_response_compat(payload: Value, request_id: Option<&String>) -> Value {
    let request_id_value = request_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "req_lmstudio_compat".to_string());
    let mut payload = payload;
    let Some(root) = payload.as_object_mut() else {
        return payload;
    };
    if root.get("output").and_then(Value::as_array).is_some() {
        harvest_responses_output_tool_calls(root, &request_id_value);
    } else {
        harvest_lmstudio_chat_tool_calls(root);
        normalize_lmstudio_tool_call_ids(root);
    }
    apply_lmstudio_response_defaults(root);
    payload
}

fn convert_tool_call_to_responses_function_call(
    call: &Value,
    fallback_index: usize,
) -> Option<Value> {
    let call_obj = call.as_object()?;
    let fn_obj = call_obj.get("function").and_then(Value::as_object)?;
    let name = fn_obj
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())?
        .to_string();
    let call_id = call_obj
        .get("call_id")
        .or_else(|| call_obj.get("id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| format!("call_{}", fallback_index));
    let arguments = match fn_obj.get("arguments") {
        Some(Value::String(text)) => text.clone(),
        Some(other) => serde_json::to_string(other).unwrap_or_else(|_| "{}".to_string()),
        None => "{}".to_string(),
    };
    Some(json!({
        "type": "function_call",
        "id": normalize_function_call_id(Some(call_id.as_str()), "fc_auto"),
        "call_id": call_id,
        "name": name,
        "arguments": arguments
    }))
}

fn harvest_responses_output_tool_calls(root: &mut Map<String, Value>, _request_id: &str) {
    let Some(entries) = root.get("output").and_then(Value::as_array) else {
        return;
    };
    if entries.is_empty() {
        return;
    }
    let mut changed = false;
    let mut call_counter = 0usize;
    let mut next_output = Vec::with_capacity(entries.len());
    for entry in entries {
        let Some(entry_obj) = entry.as_object() else {
            next_output.push(entry.clone());
            continue;
        };
        let item_type = entry_obj
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        let role = entry_obj
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("assistant")
            .trim()
            .to_ascii_lowercase();
        if item_type != "message" || role != "assistant" {
            next_output.push(entry.clone());
            continue;
        }
        let text = extract_responses_message_text(entry_obj);
        if text.is_empty() {
            next_output.push(entry.clone());
            continue;
        }
        let recovered = recover_qwen_style_tool_tokens_from_text(&text);
        if recovered.is_empty() {
            next_output.push(entry.clone());
            continue;
        }
        changed = true;
        for call in recovered {
            call_counter += 1;
            if let Some(item) = convert_tool_call_to_responses_function_call(&call, call_counter) {
                next_output.push(item);
            }
        }
    }
    if changed {
        root.insert("output".to_string(), Value::Array(next_output));
    }
}

fn read_trimmed_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn normalize_routecodex_tool_name(raw: Option<&str>) -> Option<String> {
    let value = raw?.trim();
    if value.is_empty() {
        return None;
    }
    let lowered = value.to_ascii_lowercase();
    match lowered.as_str() {
        "exec" | "shell" | "terminal" | "bash" | "sh" => Some("exec_command".to_string()),
        "patch" | "applypatch" | "apply-patch" => Some("apply_patch".to_string()),
        "plan" => Some("update_plan".to_string()),
        "image" => Some("view_image".to_string()),
        _ => {
            let mut out = String::new();
            for ch in value.chars() {
                if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' || ch == '.' {
                    out.push(ch);
                } else if !ch.is_whitespace() {
                    out.push('_');
                }
            }
            let trimmed = out
                .trim_matches(|ch: char| matches!(ch, '_' | '-' | '.'))
                .to_string();
            if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("tool") {
                None
            } else {
                Some(trimmed)
            }
        }
    }
}

fn sanitize_id_token(value: &str) -> String {
    let sanitized: String = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
                ch
            } else {
                '_'
            }
        })
        .collect();
    let trimmed = sanitized.trim_matches('_').to_string();
    if trimmed.is_empty() {
        "id".to_string()
    } else {
        trimmed
    }
}

fn short_hash(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    let digest = hasher.finalize();
    digest
        .iter()
        .take(5)
        .map(|byte| format!("{:02x}", byte))
        .collect::<String>()
}

fn normalize_function_call_id(call_id: Option<&str>, fallback: &str) -> String {
    let raw = call_id.unwrap_or(fallback).trim();
    let safe = sanitize_id_token(raw);
    let normalized = if safe.to_ascii_lowercase().starts_with("fc_") {
        safe.clone()
    } else {
        format!("fc_{}", safe.trim_start_matches("call_"))
    };
    if normalized.len() <= 64 {
        return normalized;
    }
    let hash = short_hash(raw);
    let room = 64usize.saturating_sub("fc_".len() + 1 + hash.len()).max(1);
    let head = sanitize_id_token(&safe.chars().take(room).collect::<String>());
    format!("fc_{}_{}", head, hash)
}

fn stringify_arguments(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(value) => serde_json::to_string(value).unwrap_or_else(|_| "{}".to_string()),
        None => "{}".to_string(),
    }
}

#[derive(Debug, Clone)]
struct ParsedCompatToolCall {
    call_id: Option<String>,
    name: String,
    arguments: String,
}

fn parsed_tool_call_from_value(value: &Value) -> Option<ParsedCompatToolCall> {
    let row = value.as_object()?;
    let function = row.get("function").and_then(Value::as_object);
    let name = function
        .and_then(|row| read_trimmed_string(row.get("name")))
        .or_else(|| read_trimmed_string(row.get("name")))?;
    let normalized_name = normalize_routecodex_tool_name(Some(name.as_str()))?;
    let arguments = function
        .and_then(|row| row.get("arguments"))
        .or_else(|| row.get("arguments"))
        .or_else(|| row.get("input"));
    let call_id = read_trimmed_string(row.get("call_id"))
        .or_else(|| read_trimmed_string(row.get("tool_call_id")))
        .or_else(|| read_trimmed_string(row.get("id")));
    Some(ParsedCompatToolCall {
        call_id,
        name: normalized_name,
        arguments: stringify_arguments(arguments),
    })
}

fn parsed_tool_calls_from_json_value(value: &Value) -> Vec<ParsedCompatToolCall> {
    if let Some(row) = value.as_object() {
        if let Some(calls) = row.get("tool_calls").and_then(Value::as_array) {
            return calls
                .iter()
                .filter_map(parsed_tool_call_from_value)
                .collect();
        }
        if row.get("name").is_some() || row.get("function").is_some() {
            return parsed_tool_call_from_value(value).into_iter().collect();
        }
    }
    if let Some(items) = value.as_array() {
        return items
            .iter()
            .flat_map(parsed_tool_calls_from_json_value)
            .collect();
    }
    Vec::new()
}

fn extract_balanced_json_candidate_at(text: &str, start: usize) -> Option<(usize, String)> {
    let bytes = text.as_bytes();
    let open = *bytes.get(start)?;
    let close = match open {
        b'{' => b'}',
        b'[' => b']',
        _ => return None,
    };
    let mut depth: i32 = 0;
    let mut in_string = false;
    let mut escape = false;
    for (offset, ch) in text[start..].char_indices() {
        if in_string {
            if escape {
                escape = false;
            } else if ch == '\\' {
                escape = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }
        match ch as u8 {
            b'"' => in_string = true,
            value if value == open => depth += 1,
            value if value == close => {
                depth -= 1;
                if depth == 0 {
                    let end = start + offset + ch.len_utf8();
                    return Some((end, text[start..end].to_string()));
                }
            }
            _ => {}
        }
    }
    None
}

fn collect_json_candidates(text: &str) -> Vec<String> {
    let mut candidates = Vec::new();
    let function_calls_re = Regex::new(r"(?is)<function_calls>([\s\S]*?)</function_calls>")
        .expect("valid function_calls regex");
    for caps in function_calls_re.captures_iter(text) {
        if let Some(body) = caps.get(1) {
            let trimmed = body.as_str().trim();
            if !trimmed.is_empty() {
                candidates.push(trimmed.to_string());
            }
        }
    }
    if candidates.is_empty() && (text.contains("tool_calls") || text.contains("\"name\"")) {
        let mut index = 0usize;
        while index < text.len() {
            let Some(ch) = text[index..].chars().next() else {
                break;
            };
            if ch == '{' || ch == '[' {
                if let Some((end, candidate)) = extract_balanced_json_candidate_at(text, index) {
                    candidates.push(candidate);
                    index = end;
                    continue;
                }
            }
            index += ch.len_utf8();
        }
    }
    candidates
}

fn parse_json_tool_calls(text: &str) -> Vec<ParsedCompatToolCall> {
    collect_json_candidates(text)
        .iter()
        .filter_map(|candidate| serde_json::from_str::<Value>(candidate).ok())
        .flat_map(|value| parsed_tool_calls_from_json_value(&value))
        .collect()
}

fn parse_xml_scalar(raw: &str) -> Value {
    serde_json::from_str::<Value>(raw).unwrap_or_else(|_| Value::String(raw.to_string()))
}

fn parse_invoke_tool_calls(text: &str) -> Vec<ParsedCompatToolCall> {
    let invoke_re =
        Regex::new(r#"(?is)<invoke\s+name=[\"']([^\"']+)[\"'][^>]*>([\s\S]*?)</invoke>"#)
            .expect("valid invoke regex");
    let param_re =
        Regex::new(r#"(?is)<parameter\s+name=[\"']([^\"']+)[\"'][^>]*>([\s\S]*?)</parameter>"#)
            .expect("valid parameter regex");
    let mut out = Vec::new();
    for caps in invoke_re.captures_iter(text) {
        let Some(name) = caps.get(1).map(|m| m.as_str().trim()) else {
            continue;
        };
        let Some(normalized_name) = normalize_routecodex_tool_name(Some(name)) else {
            continue;
        };
        let inner = caps.get(2).map(|m| m.as_str()).unwrap_or_default();
        let mut args = Map::new();
        for param_caps in param_re.captures_iter(inner) {
            let key = param_caps
                .get(1)
                .map(|m| m.as_str().trim())
                .filter(|key| !key.is_empty());
            let raw = param_caps
                .get(2)
                .map(|m| m.as_str().trim())
                .unwrap_or_default();
            if let Some(key) = key {
                args.insert(key.to_string(), parse_xml_scalar(raw));
            }
        }
        out.push(ParsedCompatToolCall {
            call_id: None,
            name: normalized_name,
            arguments: stringify_arguments(Some(&Value::Object(args))),
        });
    }
    out
}

fn parse_arg_pair_tool_calls(text: &str) -> Vec<ParsedCompatToolCall> {
    let block_re =
        Regex::new(r"(?is)<tool_call[^>]*>[\s\S]*?</tool_call>").expect("valid tool_call regex");
    let name_tag_re =
        Regex::new(r"(?is)<tool_name>([\s\S]*?)</tool_name>").expect("valid tool_name regex");
    let pair_re =
        Regex::new(r"(?is)<arg_key>([\s\S]*?)</arg_key>\s*<arg_value>([\s\S]*?)</arg_value>")
            .expect("valid arg pair regex");
    let mut out = Vec::new();
    for block in block_re.find_iter(text) {
        let block_text = block.as_str();
        let mut name = name_tag_re
            .captures(block_text)
            .and_then(|caps| caps.get(1))
            .map(|m| m.as_str().trim().to_string())
            .unwrap_or_default();
        if name.is_empty() {
            if block_text.contains("exec_command") || block_text.contains("<arg_key>cmd</arg_key>")
            {
                name = "exec_command".to_string();
            } else if block_text.contains("apply_patch") {
                name = "apply_patch".to_string();
            } else if block_text.contains("update_plan") {
                name = "update_plan".to_string();
            } else if block_text.contains("view_image") {
                name = "view_image".to_string();
            }
        }
        let Some(normalized_name) = normalize_routecodex_tool_name(Some(name.as_str())) else {
            continue;
        };
        let mut args = Map::new();
        for caps in pair_re.captures_iter(block_text) {
            let key = caps
                .get(1)
                .map(|m| m.as_str().trim())
                .filter(|key| !key.is_empty());
            let raw = caps.get(2).map(|m| m.as_str().trim()).unwrap_or_default();
            if let Some(key) = key {
                let normalized_key = if normalized_name == "exec_command" && key == "command" {
                    "cmd"
                } else {
                    key
                };
                args.insert(normalized_key.to_string(), parse_xml_scalar(raw));
            }
        }
        out.push(ParsedCompatToolCall {
            call_id: None,
            name: normalized_name,
            arguments: stringify_arguments(Some(&Value::Object(args))),
        });
    }
    out
}

fn parse_text_tool_calls(text: &str) -> Vec<ParsedCompatToolCall> {
    let json_calls = parse_json_tool_calls(text);
    if !json_calls.is_empty() {
        return json_calls;
    }
    let invoke_calls = parse_invoke_tool_calls(text);
    if !invoke_calls.is_empty() {
        return invoke_calls;
    }
    parse_arg_pair_tool_calls(text)
}

fn extract_responses_message_text(item: &Map<String, Value>) -> String {
    let mut parts = Vec::new();
    if let Some(Value::Array(content)) = item.get("content") {
        for part in content {
            let Some(part_obj) = part.as_object() else {
                continue;
            };
            if let Some(text) = read_trimmed_string(part_obj.get("text"))
                .or_else(|| read_trimmed_string(part_obj.get("content")))
                .or_else(|| read_trimmed_string(part_obj.get("value")))
            {
                if !parts.iter().any(|existing| existing == &text) {
                    parts.push(text);
                }
            }
        }
    }
    if let Some(text) = read_trimmed_string(item.get("output_text")) {
        if !parts.iter().any(|existing| existing == &text) {
            parts.push(text);
        }
    }
    parts.join("\n").trim().to_string()
}

fn responses_function_call_from_parsed(call: ParsedCompatToolCall, fallback_index: usize) -> Value {
    let call_id = call
        .call_id
        .filter(|call_id| !call_id.trim().is_empty())
        .unwrap_or_else(|| format!("call_auto_{}", fallback_index));
    let item_id = normalize_function_call_id(Some(call_id.as_str()), "fc_auto");
    json!({
        "type": "function_call",
        "id": item_id,
        "call_id": call_id,
        "name": call.name,
        "arguments": call.arguments
    })
}

fn harvest_responses_output_in_place(root: &mut Map<String, Value>) {
    let Some(Value::Array(output)) = root.get("output") else {
        return;
    };
    let mut next_output = Vec::new();
    let mut changed = false;
    let mut fallback_counter = 0usize;

    for item in output {
        let Some(item_obj) = item.as_object() else {
            next_output.push(item.clone());
            continue;
        };
        let item_type = read_trimmed_string(item_obj.get("type"))
            .map(|value| value.to_ascii_lowercase())
            .unwrap_or_default();
        let role = read_trimmed_string(item_obj.get("role"))
            .map(|value| value.to_ascii_lowercase())
            .unwrap_or_default();
        if item_type != "message" || role != "assistant" {
            next_output.push(item.clone());
            continue;
        }
        let text = extract_responses_message_text(item_obj);
        if text.is_empty() {
            next_output.push(item.clone());
            continue;
        }
        let calls = parse_text_tool_calls(text.as_str());
        if calls.is_empty() {
            next_output.push(item.clone());
            continue;
        }
        changed = true;
        for call in calls {
            fallback_counter += 1;
            next_output.push(responses_function_call_from_parsed(call, fallback_counter));
        }
    }

    if changed {
        root.insert("output".to_string(), Value::Array(next_output));
        root.remove("output_text");
    }
}

fn chat_tool_call_from_parsed(call: ParsedCompatToolCall, fallback_index: usize) -> Value {
    let call_id = call
        .call_id
        .filter(|call_id| !call_id.trim().is_empty())
        .unwrap_or_else(|| format!("call_auto_{}", fallback_index));
    json!({
        "id": call_id,
        "type": "function",
        "function": {
            "name": call.name,
            "arguments": call.arguments,
        }
    })
}

fn harvest_chat_choices_in_place(root: &mut Map<String, Value>) {
    let Some(Value::Array(choices)) = root.get_mut("choices") else {
        return;
    };
    for choice in choices.iter_mut() {
        let Some(choice_obj) = choice.as_object_mut() else {
            continue;
        };
        let text = choice_obj
            .get("message")
            .and_then(Value::as_object)
            .and_then(|message| read_trimmed_string(message.get("content")))
            .unwrap_or_default();
        if text.is_empty() {
            continue;
        }
        let calls = parse_text_tool_calls(text.as_str());
        if calls.is_empty() {
            continue;
        }
        let tool_calls: Vec<Value> = calls
            .into_iter()
            .enumerate()
            .map(|(idx, call)| chat_tool_call_from_parsed(call, idx + 1))
            .collect();
        if let Some(message) = choice_obj.get_mut("message").and_then(Value::as_object_mut) {
            message.insert("tool_calls".to_string(), Value::Array(tool_calls));
            message.insert("content".to_string(), Value::Null);
        }
        let finish = read_trimmed_string(choice_obj.get("finish_reason"))
            .map(|value| value.to_ascii_lowercase())
            .unwrap_or_default();
        if finish.is_empty() || finish == "stop" || finish == "length" {
            choice_obj.insert(
                "finish_reason".to_string(),
                Value::String("tool_calls".to_string()),
            );
        }
    }
}

fn harvest_text_tool_calls(payload: Value) -> Result<Value, String> {
    let mut payload = payload;
    let Some(root) = payload.as_object_mut() else {
        return Ok(payload);
    };
    let choices_len = root
        .get("choices")
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0);
    if choices_len > 0 {
        harvest_chat_choices_in_place(root);
    } else {
        harvest_responses_output_in_place(root);
    }
    Ok(payload)
}

fn apply_glm_response_compat(payload: Value) -> Value {
    let Some(root) = payload.as_object() else {
        return payload;
    };
    let Some(choices) = root.get("choices").and_then(Value::as_array) else {
        return payload;
    };
    let mut next_root = root.clone();
    let mut changed = false;
    let mut next_choices = Vec::new();
    for choice in choices {
        let Some(choice_obj) = choice.as_object() else {
            next_choices.push(choice.clone());
            continue;
        };
        let Some(message) = choice_obj.get("message").and_then(Value::as_object) else {
            next_choices.push(choice.clone());
            continue;
        };
        let reasoning = read_trimmed_string(message.get("reasoning_content"))
            .or_else(|| read_trimmed_string(message.get("reasoning")))
            .unwrap_or_default();
        if reasoning.is_empty() {
            next_choices.push(choice.clone());
            continue;
        }
        let calls = parse_text_tool_calls(reasoning.as_str());
        if calls.is_empty() {
            next_choices.push(choice.clone());
            continue;
        }
        let tool_calls: Vec<Value> = calls
            .into_iter()
            .enumerate()
            .map(|(idx, call)| chat_tool_call_from_parsed(call, idx + 1))
            .collect();
        let mut next_choice = choice_obj.clone();
        let mut next_message = message.clone();
        next_message.insert("tool_calls".to_string(), Value::Array(tool_calls));
        next_message.insert("content".to_string(), Value::Null);
        next_choice.insert("message".to_string(), Value::Object(next_message));
        next_choice.insert(
            "finish_reason".to_string(),
            Value::String("tool_calls".to_string()),
        );
        next_choices.push(Value::Object(next_choice));
        changed = true;
    }
    if changed {
        next_root.insert("choices".to_string(), Value::Array(next_choices));
        Value::Object(next_root)
    } else {
        payload
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn minimax_response_profile_harvests_responses_function_calls_xml_without_text_leak() {
        let input = ReqOutboundCompatInput {
            payload: json!({
                "object": "response",
                "id": "resp_minimax_tool_text_1",
                "output": [{
                    "type": "message",
                    "role": "assistant",
                    "content": [{
                        "type": "output_text",
                        "text": "<function_calls>{\"tool_calls\":[{\"name\":\"exec_command\",\"arguments\":{\"cmd\":\"pwd\"}}]}</function_calls>"
                    }],
                    "output_text": "<function_calls>{\"tool_calls\":[{\"name\":\"exec_command\",\"arguments\":{\"cmd\":\"pwd\"}}]}</function_calls>"
                }],
                "output_text": "<function_calls>{\"tool_calls\":[{\"name\":\"exec_command\",\"arguments\":{\"cmd\":\"pwd\"}}]}</function_calls>"
            }),
            adapter_context: AdapterContext {
                compatibility_profile: Some("chat:minimax".to_string()),
                provider_protocol: Some("openai-responses".to_string()),
                ..Default::default()
            },
            explicit_profile: None,
        };
        let result = run_resp_inbound_stage3_compat(input).unwrap();
        assert!(result.native_applied);
        assert_eq!(result.applied_profile.as_deref(), Some("chat:minimax"));
        assert_eq!(result.payload["output"][0]["type"], "function_call");
        assert_eq!(result.payload["output"][0]["name"], "exec_command");
        assert_eq!(
            result.payload["output"][0]["arguments"]
                .as_str()
                .unwrap_or(""),
            "{\"cmd\":\"pwd\"}"
        );
        let serialized = serde_json::to_string(&result.payload).unwrap();
        assert!(!serialized.contains("<function_calls>"));
    }

    #[test]
    fn minimax_response_profile_harvests_invoke_xml_tool_call() {
        let input = ReqOutboundCompatInput {
            payload: json!({
                "object": "response",
                "id": "resp_minimax_invoke_tool_1",
                "output": [{
                    "type": "message",
                    "role": "assistant",
                    "content": [{
                        "type": "output_text",
                        "text": "<tool_call><invoke name=\"exec\"><parameter name=\"cmd\">pwd</parameter></invoke></tool_call>"
                    }]
                }]
            }),
            adapter_context: AdapterContext {
                compatibility_profile: Some("chat:minimax".to_string()),
                provider_protocol: Some("openai-responses".to_string()),
                ..Default::default()
            },
            explicit_profile: None,
        };
        let result = run_resp_inbound_stage3_compat(input).unwrap();
        assert_eq!(result.payload["output"][0]["type"], "function_call");
        assert_eq!(result.payload["output"][0]["name"], "exec_command");
        assert_eq!(
            result.payload["output"][0]["arguments"]
                .as_str()
                .unwrap_or(""),
            "{\"cmd\":\"pwd\"}"
        );
    }

    #[test]
    fn passthrough_profile_does_not_harvest_minimax_text() {
        let input = ReqOutboundCompatInput {
            payload: json!({
                "object": "response",
                "output": [{
                    "type": "message",
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": "<function_calls>{\"tool_calls\":[{\"name\":\"exec_command\",\"arguments\":{\"cmd\":\"pwd\"}}]}</function_calls>"}]
                }]
            }),
            adapter_context: AdapterContext {
                compatibility_profile: None,
                provider_protocol: Some("openai-responses".to_string()),
                ..Default::default()
            },
            explicit_profile: None,
        };
        let result = run_resp_inbound_stage3_compat(input).unwrap();
        assert_eq!(result.applied_profile, None);
        assert_eq!(result.payload["output"][0]["type"], "message");
    }

    #[test]
    fn request_stage_loads_profile_without_payload_cleanup() {
        let input = ReqOutboundCompatInput {
            payload: json!({
                "messages": [{"role": "user", "content": "hi"}],
                "semantics": {"internal": true},
                "processed": {"marker": "must-preserve"},
                "processingMetadata": {"marker": "must-preserve"}
            }),
            adapter_context: AdapterContext {
                compatibility_profile: Some("chat:minimax".to_string()),
                provider_protocol: Some("openai-responses".to_string()),
                ..Default::default()
            },
            explicit_profile: None,
        };
        let result = run_req_outbound_stage3_compat(input).unwrap();
        assert_eq!(result.applied_profile.as_deref(), Some("chat:minimax"));
        assert_eq!(result.payload["semantics"], json!({"internal": true}));
        assert_eq!(
            result.payload["processed"],
            json!({"marker": "must-preserve"})
        );
        assert_eq!(
            result.payload["processingMetadata"],
            json!({"marker": "must-preserve"})
        );
        assert_eq!(result.payload["messages"][0]["content"], "hi");
    }

    #[test]
    fn responses_crs_request_profile_normalizes_tools_and_removes_temperature() {
        let input = ReqOutboundCompatInput {
            payload: json!({
                "model": "gpt-5.5",
                "temperature": 0.2,
                "tools": [{
                    "type": "function",
                    "function": {
                        "name": "lookup",
                        "description": "Lookup",
                        "parameters": "{\"type\":\"object\",\"properties\":{\"q\":{\"type\":\"string\"}}}"
                    }
                }],
                "input": [{"type":"reasoning","content":[{"type":"summary_text","text":"old"}]}]
            }),
            adapter_context: AdapterContext {
                compatibility_profile: Some("responses:crs".to_string()),
                provider_protocol: Some("openai-responses".to_string()),
                ..Default::default()
            },
            explicit_profile: None,
        };
        let result = run_req_outbound_stage3_compat(input).unwrap();
        assert_eq!(result.applied_profile.as_deref(), Some("responses:crs"));
        assert!(result.payload.get("temperature").is_none());
        assert_eq!(result.payload["tools"][0]["name"], "lookup");
        assert_eq!(
            result.payload["tools"][0]["parameters"]["properties"]["q"]["type"],
            "string"
        );
        assert!(result.payload["input"][0].get("content").is_none());
    }

    #[test]
    fn single_tool_call_history_profile_splits_parallel_assistant_messages() {
        let input = ReqOutboundCompatInput {
            payload: json!({
                "messages": [{
                    "role":"assistant",
                    "content":"prior",
                    "tool_calls":[
                        {"id":"call_a","type":"function","function":{"name":"a","arguments":"{}"}},
                        {"id":"call_b","type":"function","function":{"name":"b","arguments":"{}"}}
                    ]
                }]
            }),
            adapter_context: AdapterContext {
                compatibility_profile: Some("chat:single-tool-call-history".to_string()),
                provider_protocol: Some("openai-chat".to_string()),
                ..Default::default()
            },
            explicit_profile: None,
        };
        let result = run_req_outbound_stage3_compat(input).unwrap();
        assert_eq!(
            result.applied_profile.as_deref(),
            Some("chat:single-tool-call-history")
        );
        assert_eq!(result.payload["messages"].as_array().unwrap().len(), 2);
        assert_eq!(
            result.payload["messages"][0]["tool_calls"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(result.payload["messages"][1]["content"], Value::Null);
    }

    #[test]
    fn gemini_profile_shallow_picks_and_adds_search_tools_on_search_route() {
        let input = ReqOutboundCompatInput {
            payload: json!({
                "model":"gemini-test",
                "contents":[{"role":"user","parts":[{"text":"search"}]}],
                "web_search":{"query":"x"},
                "metadata_center":{"must":"drop"}
            }),
            adapter_context: AdapterContext {
                compatibility_profile: Some("chat:gemini".to_string()),
                provider_protocol: Some("gemini-chat".to_string()),
                route_id: Some("web_search".to_string()),
                ..Default::default()
            },
            explicit_profile: None,
        };
        let result = run_req_outbound_stage3_compat(input).unwrap();
        assert_eq!(result.applied_profile.as_deref(), Some("chat:gemini"));
        assert!(result.payload.get("metadata_center").is_none());
        assert!(result.payload.get("web_search").is_none());
        assert!(result.payload["tools"][0].get("googleSearch").is_some());
    }

    #[test]
    fn lmstudio_response_profile_adds_chat_defaults_and_harvests_qwen_tokens() {
        let input = ReqOutboundCompatInput {
            payload: json!({
                "choices":[{
                    "index":0,
                    "finish_reason":"stop",
                    "message":{
                        "role":"assistant",
                        "content":"<|tool_calls_section_begin|><|tool_call_begin|>functions.exec_command<|tool_call_argument_begin|>{\"cmd\":\"pwd\"}<|tool_call_end|><|tool_calls_section_end|>"
                    }
                }]
            }),
            adapter_context: AdapterContext {
                compatibility_profile: Some("chat:lmstudio".to_string()),
                provider_protocol: Some("openai-chat".to_string()),
                request_id: Some("req_lmstudio_test".to_string()),
                ..Default::default()
            },
            explicit_profile: None,
        };
        let result = run_resp_inbound_stage3_compat(input).unwrap();
        assert_eq!(result.applied_profile.as_deref(), Some("chat:lmstudio"));
        assert_eq!(result.payload["object"], "chat.completion");
        assert_eq!(
            result.payload["choices"][0]["message"]["tool_calls"][0]["function"]["name"],
            "exec_command"
        );
    }
}
