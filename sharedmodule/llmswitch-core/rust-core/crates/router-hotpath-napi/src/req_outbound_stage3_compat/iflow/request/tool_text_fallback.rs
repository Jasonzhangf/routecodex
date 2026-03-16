use napi::bindgen_prelude::Result as NapiResult;
use serde_json::{json, Map, Value};

use super::super::super::AdapterContext;

fn is_record(value: &Value) -> bool {
    value.is_object()
}

fn normalize_model(value: Option<&Value>) -> String {
    value
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_default()
}

fn is_web_search_route(adapter_context: &AdapterContext) -> bool {
    let normalized = adapter_context
        .route_id
        .as_ref()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_default();
    normalized.starts_with("web_search") || normalized.starts_with("search")
}

fn has_non_empty_array(value: Option<&Value>) -> bool {
    value
        .and_then(|v| v.as_array())
        .map(|arr| !arr.is_empty())
        .unwrap_or(false)
}

fn build_tool_markup_instruction() -> String {
    [
        "## Tool Calls (Text Markup Mode)",
        "",
        "You MAY call tools by emitting one or more XML blocks with this exact format, and nothing else inside the block:",
        "",
        "<tool:exec_command>",
        "<command>...</command>",
        "<timeout_ms>10000</timeout_ms>",
        "</tool:exec_command>",
        "",
        "<tool:write_stdin>",
        "<session_id>...</session_id>",
        "<input>...</input>",
        "</tool:write_stdin>",
        "",
        "Rules:",
        "- Use `<tool:exec_command>` to run shell commands.",
        "- Use `<tool:write_stdin>` to send input to an existing session.",
        "- Do NOT wrap these blocks in code fences.",
        "- Do NOT invent tools; only use exec_command and write_stdin.",
        "",
    ]
    .join("\n")
}

fn stringify_tool_output(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => serde_json::to_string_pretty(other).unwrap_or_else(|_| other.to_string()),
    }
}

fn coerce_tool_call_to_xml_block(tool_call: &Value) -> Option<String> {
    let row = tool_call.as_object()?;
    let type_name = row
        .get("type")
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if !type_name.is_empty() && type_name != "function" {
        return None;
    }
    let function = row.get("function")?.as_object()?;
    let name = function.get("name").and_then(|v| v.as_str())?.trim();
    if name.is_empty() {
        return None;
    }

    let args_value = match function.get("arguments") {
        Some(Value::String(text)) if !text.trim().is_empty() => {
            serde_json::from_str::<Value>(text).unwrap_or_else(|_| json!({ "raw": text }))
        }
        Some(other) => other.clone(),
        None => Value::Null,
    };
    let args = args_value.as_object();

    match name {
        "exec_command" => {
            let command = args
                .and_then(|m| m.get("cmd").or_else(|| m.get("command")))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            if command.is_empty() {
                return None;
            }
            let timeout_ms = args
                .and_then(|m| m.get("timeout_ms"))
                .and_then(|v| v.as_f64())
                .filter(|v| v.is_finite())
                .map(|v| v.floor() as i64);
            let mut lines = vec![
                "<tool:exec_command>".to_string(),
                format!("<command>{}</command>", command),
            ];
            if let Some(timeout) = timeout_ms {
                lines.push(format!("<timeout_ms>{}</timeout_ms>", timeout));
            }
            lines.push("</tool:exec_command>".to_string());
            Some(lines.join("\n"))
        }
        "write_stdin" => {
            let session_id = args
                .and_then(|m| m.get("session_id").or_else(|| m.get("sessionId")))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            let input = args
                .and_then(|m| m.get("chars").or_else(|| m.get("input")))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            if session_id.is_empty() || input.is_empty() {
                return None;
            }
            Some(
                [
                    "<tool:write_stdin>".to_string(),
                    format!("<session_id>{}</session_id>", session_id),
                    format!("<input>{}</input>", input),
                    "</tool:write_stdin>".to_string(),
                ]
                .join("\n"),
            )
        }
        _ => None,
    }
}

fn rewrite_message_tool_surface_in_place(message: &mut Map<String, Value>) {
    let role = message
        .get("role")
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_default();

    if role == "tool" {
        let tool_name = message
            .get("name")
            .and_then(|v| v.as_str())
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty());
        let tool_call_id = message
            .get("tool_call_id")
            .and_then(|v| v.as_str())
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty());
        let content = stringify_tool_output(message.get("content"));
        let mut lines = vec!["Tool result:".to_string()];
        if let Some(name) = tool_name {
            lines.push(format!("name: {}", name));
        }
        if let Some(id) = tool_call_id {
            lines.push(format!("tool_call_id: {}", id));
        }
        lines.push("output:".to_string());
        lines.push(content);
        message.insert("role".to_string(), Value::String("user".to_string()));
        message.insert("content".to_string(), Value::String(lines.join("\n")));
        message.remove("name");
        message.remove("tool_call_id");
        return;
    }

    let Some(tool_calls) = message.get("tool_calls").and_then(|v| v.as_array()) else {
        return;
    };
    if tool_calls.is_empty() {
        message.remove("tool_calls");
        return;
    }
    let blocks = tool_calls
        .iter()
        .filter_map(coerce_tool_call_to_xml_block)
        .collect::<Vec<String>>();
    if !blocks.is_empty() {
        let prev = message
            .get("content")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let joined = blocks.join("\n\n");
        let next = if prev.trim().is_empty() {
            joined
        } else {
            format!("{}\n\n{}", prev, joined)
        };
        message.insert("content".to_string(), Value::String(next));
    }
    message.remove("tool_calls");
}

fn ensure_system_message(messages: &mut Vec<Value>) {
    let has_system = messages
        .first()
        .and_then(|v| v.as_object())
        .and_then(|obj| obj.get("role"))
        .and_then(|v| v.as_str())
        .map(|v| v.eq_ignore_ascii_case("system"))
        .unwrap_or(false);
    if has_system {
        return;
    }
    messages.insert(
        0,
        Value::Object(Map::from_iter([
            ("role".to_string(), Value::String("system".to_string())),
            ("content".to_string(), Value::String(String::new())),
        ])),
    );
}

fn append_system_text(sys: &mut Map<String, Value>, extra: &str) {
    let prev = sys
        .get("content")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if prev.contains("## Tool Calls (Text Markup Mode)") {
        return;
    }
    let combined = if prev.is_empty() {
        extra.to_string()
    } else {
        format!("{}\n\n{}", prev, extra)
    };
    sys.insert("content".to_string(), Value::String(combined));
}

pub(crate) fn apply_iflow_tool_text_fallback(
    root: &mut Map<String, Value>,
    adapter_context: &AdapterContext,
    models: &[String],
) {
    if is_web_search_route(adapter_context) {
        return;
    }

    let model = normalize_model(root.get("model"));
    if model.is_empty() || !models.iter().any(|m| m == &model) {
        return;
    }

    if !has_non_empty_array(root.get("messages")) {
        return;
    }

    root.remove("tools");
    root.remove("tool_choice");

    if let Some(messages) = root.get_mut("messages").and_then(|v| v.as_array_mut()) {
        for message in messages.iter_mut() {
            if let Some(obj) = message.as_object_mut() {
                rewrite_message_tool_surface_in_place(obj);
            }
        }
        ensure_system_message(messages);
        if let Some(sys) = messages.first_mut().and_then(|v| v.as_object_mut()) {
            append_system_text(sys, &build_tool_markup_instruction());
        }
    }
}

pub(crate) fn apply_iflow_tool_text_fallback_json(
    payload_json: String,
    adapter_context_json: Option<String>,
    models_json: Option<String>,
) -> NapiResult<String> {
    let mut payload: Value =
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
            anthropic_thinking: None,
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
    let models = match models_json {
        Some(raw) if !raw.trim().is_empty() => serde_json::from_str::<Vec<String>>(&raw)
            .map_err(|e| napi::Error::from_reason(e.to_string()))?
            .into_iter()
            .map(|v| v.trim().to_ascii_lowercase())
            .filter(|v| !v.is_empty())
            .collect::<Vec<String>>(),
        _ => Vec::new(),
    };

    if let Some(root) = payload.as_object_mut() {
        apply_iflow_tool_text_fallback(root, &adapter_context, &models);
    }

    serde_json::to_string(&payload).map_err(|e| napi::Error::from_reason(e.to_string()))
}
