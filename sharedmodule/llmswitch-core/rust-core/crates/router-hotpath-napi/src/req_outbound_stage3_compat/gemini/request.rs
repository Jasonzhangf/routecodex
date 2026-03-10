use napi::bindgen_prelude::Result as NapiResult;
use serde_json::{json, Map, Value};

use super::super::AdapterContext;
use super::tool_schema::apply_claude_thinking_tool_schema_compat;

const SEARCH_ROUTE_PREFIXES: [&str; 2] = ["web_search", "search"];
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

fn read_trimmed_string(value: Option<&Value>) -> Option<String> {
    let raw = value.and_then(|v| v.as_str())?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.to_string())
}

fn is_search_route(adapter_context: &AdapterContext) -> bool {
    let route_id = adapter_context
        .route_id
        .as_ref()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_default();
    SEARCH_ROUTE_PREFIXES
        .iter()
        .any(|prefix| route_id.starts_with(prefix))
}

fn build_default_tools() -> Value {
    Value::Array(vec![json!({ "googleSearch": {} })])
}

fn apply_gemini_shallow_pick(payload: Value) -> Value {
    let Some(root) = payload.as_object() else {
        return payload;
    };
    let mut next = Map::<String, Value>::new();
    for key in GEMINI_ALLOW_TOP_LEVEL {
        if let Some(value) = root.get(key) {
            next.insert(key.to_string(), value.clone());
        }
    }
    Value::Object(next)
}

pub(crate) fn apply_gemini_web_search_request_compat(
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
    if next.contains_key("web_search") {
        next.remove("web_search");
    }

    let tools_rows = next.get("tools").and_then(|v| v.as_array());
    let Some(tools_rows) = tools_rows else {
        next.insert("tools".to_string(), build_default_tools());
        return Value::Object(next);
    };

    let mut next_tools: Vec<Value> = Vec::new();
    for entry in tools_rows {
        let Some(entry_obj) = entry.as_object() else {
            continue;
        };

        let mut web_search_decls: Vec<Value> = Vec::new();
        let decls = entry_obj
            .get("functionDeclarations")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        for decl in decls {
            let Some(decl_obj) = decl.as_object() else {
                continue;
            };
            let name = read_trimmed_string(decl_obj.get("name"))
                .map(|v| v.to_ascii_lowercase())
                .unwrap_or_default();
            if name == "web_search" {
                web_search_decls.push(Value::Object(decl_obj.clone()));
            }
        }
        if !web_search_decls.is_empty() {
            let mut node = Map::<String, Value>::new();
            node.insert(
                "functionDeclarations".to_string(),
                Value::Array(web_search_decls),
            );
            next_tools.push(Value::Object(node));
            continue;
        }

        if let Some(google_search) = entry_obj.get("googleSearch").and_then(|v| v.as_object()) {
            let mut node = Map::<String, Value>::new();
            node.insert(
                "googleSearch".to_string(),
                Value::Object(google_search.clone()),
            );
            next_tools.push(Value::Object(node));
        }
    }

    if next_tools.is_empty() {
        next.insert("tools".to_string(), build_default_tools());
    } else {
        next.insert("tools".to_string(), Value::Array(next_tools));
    }

    Value::Object(next)
}

pub(crate) fn apply_gemini_web_search_request_compat_json(
    payload_json: String,
    adapter_context_json: Option<String>,
) -> NapiResult<String> {
    let payload: Value =
        serde_json::from_str(&payload_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let adapter_context: AdapterContext = match adapter_context_json {
        Some(raw) if !raw.trim().is_empty() => {
            serde_json::from_str(&raw).map_err(|e| napi::Error::from_reason(e.to_string()))?
        }
        _ => AdapterContext {
            compatibility_profile: None,
            provider_protocol: None,
            request_id: None,
            entry_endpoint: None,
            route_id: None,
            rt: None,
            captured_chat_request: None,
            deepseek: None,
            claude_code: None,
            estimated_input_tokens: None,
            model_id: None,
            client_model_id: None,
            original_model_id: None,
            provider_id: None,
            provider_key: None,
            runtime_key: None,
            client_request_id: None,
            group_request_id: None,
            session_id: None,
            conversation_id: None,
        },
    };

    serde_json::to_string(&apply_gemini_web_search_request_compat(
        payload,
        &adapter_context,
    ))
    .map_err(|e| napi::Error::from_reason(e.to_string()))
}

pub(crate) fn apply_gemini_request_compat(
    payload: Value,
    adapter_context: &AdapterContext,
) -> Value {
    let payload = apply_claude_thinking_tool_schema_compat(payload);
    let payload = apply_gemini_web_search_request_compat(payload, adapter_context);
    apply_gemini_shallow_pick(payload)
}
