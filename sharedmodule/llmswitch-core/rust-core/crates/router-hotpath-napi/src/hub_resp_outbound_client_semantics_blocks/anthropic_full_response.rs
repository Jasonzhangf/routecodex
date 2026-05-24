use serde_json::{Map, Value};

use crate::hub_resp_outbound_client_semantics_blocks::anthropic_response::build_anthropic_response_from_chat_value;
use crate::responses_reasoning_registry::{
    register_responses_output_text_meta_json, register_responses_passthrough_json,
    register_responses_payload_snapshot_json, register_responses_reasoning_json,
};

#[derive(serde::Deserialize)]
pub(crate) struct BuildAnthropicFullInput {
    pub(crate) chat_response: String,
    pub(crate) alias_map: Option<String>,
    pub(crate) responses_reasoning: Option<String>,
    pub(crate) responses_output_text_meta: Option<String>,
    pub(crate) responses_payload_snapshot: Option<String>,
    pub(crate) responses_passthrough: Option<String>,
}

#[derive(serde::Serialize)]
pub(crate) struct BuildAnthropicFullOutput {
    pub(crate) result: String,
    pub(crate) id: Option<String>,
}

fn normalize_shell_like_tool_input(tool_name: &str, input: &Value) -> Value {
    let lower = tool_name.trim().to_ascii_lowercase();
    let canonical = match lower.as_str() {
        "bash" | "shell" | "terminal" | "exec_command" | "shell_command" => "shell_command",
        other => other,
    };
    if canonical != "shell_command" {
        return input.clone();
    }
    let is_exec = lower == "exec_command";

    match input {
        Value::String(s) => {
            let trimmed = s.trim().to_string();
            if trimmed.is_empty() {
                let mut m = Map::new();
                m.insert("command".to_string(), Value::String(String::new()));
                return Value::Object(m);
            }
            let key = if is_exec { "cmd" } else { "command" };
            let mut m = Map::new();
            m.insert(key.to_string(), Value::String(trimmed));
            Value::Object(m)
        }
        Value::Array(arr) => {
            let parts: Vec<String> = arr
                .iter()
                .filter_map(|v| {
                    v.as_str()
                        .map(|s| s.trim().to_string())
                        .filter(|t| !t.is_empty())
                })
                .collect();
            if parts.is_empty() {
                let mut m = Map::new();
                m.insert("command".to_string(), Value::String(String::new()));
                return Value::Object(m);
            }
            let joined = parts.join(" ");
            let key = if is_exec { "cmd" } else { "command" };
            let mut m = Map::new();
            m.insert(key.to_string(), Value::String(joined));
            Value::Object(m)
        }
        Value::Object(obj) => {
            let mut next: Map<String, Value> = obj.clone();

            let mut cmd_val: Option<&str> = None;
            for key in ["command", "cmd", "script", "toon"] {
                if let Some(v) = obj.get(key) {
                    if let Some(s) = v.as_str() {
                        let t = s.trim();
                        if !t.is_empty() {
                            cmd_val = Some(t);
                            break;
                        }
                    }
                }
            }

            if let Some(cmd) = cmd_val {
                if obj.get("command").is_some() || (is_exec && obj.get("cmd").is_some()) {
                    let key = if obj.get("command").is_some() {
                        "command"
                    } else {
                        "cmd"
                    };
                    next.insert(key.to_string(), Value::String(cmd.to_string()));
                }
            }

            if cmd_val.is_none() {
                for key in ["script", "toon"] {
                    if let Some(v) = obj.get(key) {
                        if let Some(s) = v.as_str() {
                            let t = s.trim();
                            if !t.is_empty() {
                                let insert_key = if is_exec { "cmd" } else { "command" };
                                next.insert(insert_key.to_string(), Value::String(t.to_string()));
                                break;
                            }
                        }
                    }
                }
            }

            if !is_exec {
                next.remove("cmd");
            }

            if next.get("workdir").is_none() {
                if let Some(v) = obj.get("cwd") {
                    if let Some(s) = v.as_str() {
                        let t = s.trim();
                        if !t.is_empty() {
                            next.insert("workdir".to_string(), Value::String(t.to_string()));
                        }
                    }
                }
            }
            Value::Object(next)
        }
        _ => {
            let mut m = Map::new();
            m.insert("command".to_string(), Value::String(String::new()));
            Value::Object(m)
        }
    }
}

pub(crate) fn build_anthropic_response_from_chat_full(
    input: BuildAnthropicFullInput,
) -> Result<BuildAnthropicFullOutput, String> {
    let chat_response: Value = serde_json::from_str(&input.chat_response).map_err(|e| e.to_string())?;

    let alias_map: Option<Value> = input
        .alias_map
        .as_ref()
        .and_then(|s| serde_json::from_str(s).ok());

    let mut sanitized = build_anthropic_response_from_chat_value(&chat_response, alias_map.as_ref());

    if let Some(content) = sanitized.as_object_mut().and_then(|o| o.get_mut("content")) {
        if let Some(arr) = content.as_array_mut() {
            for block in arr.iter_mut() {
                let block_obj = match block.as_object_mut() {
                    Some(o) => o,
                    None => continue,
                };
                if block_obj.get("type").and_then(|v| v.as_str()) != Some("tool_use") {
                    continue;
                }
                let name = block_obj.get("name").and_then(|v| v.as_str()).unwrap_or("");
                if let Some(input_val) = block_obj.get("input") {
                    let normalized = normalize_shell_like_tool_input(name, input_val);
                    block_obj.insert("input".to_string(), normalized);
                }
            }
        }
    }

    let sanitized_id = sanitized
        .as_object()
        .and_then(|o| o.get("id"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    if let (Some(reasoning), Some(id)) = (&input.responses_reasoning, &sanitized_id) {
        let t = reasoning.trim();
        if !t.is_empty() && t != "null" && t != "undefined" {
            let _ = register_responses_reasoning_json(id.clone(), Some(reasoning.clone()));
        }
    }

    if let (Some(meta), Some(id)) = (&input.responses_output_text_meta, &sanitized_id) {
        let t = meta.trim();
        if !t.is_empty() && t != "null" && t != "undefined" {
            let _ = register_responses_output_text_meta_json(id.clone(), meta.clone());
        }
    }

    if let (Some(snap), Some(id)) = (&input.responses_payload_snapshot, &sanitized_id) {
        let t = snap.trim();
        if !t.is_empty() && t != "null" && t != "undefined" {
            let _ = register_responses_payload_snapshot_json(id.clone(), snap.clone(), Some(false));
        }
    }

    if let (Some(passthrough), Some(id)) = (&input.responses_passthrough, &sanitized_id) {
        let t = passthrough.trim();
        if !t.is_empty() && t != "null" && t != "undefined" {
            let _ =
                register_responses_passthrough_json(id.clone(), passthrough.clone(), Some(false));
        }
    }

    let result = serde_json::to_string(&sanitized).map_err(|e| e.to_string())?;
    Ok(BuildAnthropicFullOutput {
        result,
        id: sanitized_id,
    })
}
