//! Request-side compat for strict/legacy Responses backends.
//!
//! Repro 35f96d3: `api.qingyanx.com` serves two backends behind one host. The
//! older backend rejects the newer Responses input/tool surface with:
//!   * `input: data did not match any variant of untagged enum ResponseInput`
//!     for `input[]` items of type `reasoning`;
//!   * `tools[0].type: unknown variant 'tool_search'`.
//! The newer backend accepts both. The failure is deterministic per backend,
//! so the request must be projected into the older schema to pass through.
//!
//! This module owns only the strict/legacy projection. The declared profile
//! gates it, so no other Responses provider is rewritten. It first reuses the
//! `custom_tool_function` custom->function projection, because the strict
//! backend rejects both the hosted `tool_search` shape and the newer
//! `custom_tool_call` history shape together.

use serde_json::{Map, Value};

pub const PROFILE: &str = "responses:strict-legacy-input";

/// Project the request body into the strict/legacy Responses schema:
/// drop `reasoning` input items (no such variant in the legacy schema) and
/// declare the Codex `tool_search` hosted tool as an ordinary function tool.
pub(crate) fn apply_request_compat(mut payload: Value) -> Result<Value, String> {
    let binding = crate::custom_tool_function::compile_custom_tool_function_binding(&payload);
    payload = crate::custom_tool_function::apply_request_compat_with_binding(payload, &binding)?;
    let Some(root) = payload.as_object_mut() else {
        return Err(format!(
            "MalformedPayload profile={PROFILE} reason=request_object_required"
        ));
    };
    let mut projected_tool_search = false;
    if let Some(input) = root.get_mut("input").and_then(Value::as_array_mut) {
        input.retain(|item| item.get("type").and_then(Value::as_str) != Some("reasoning"));
    }
    if let Some(tools) = root.get_mut("tools").and_then(Value::as_array_mut) {
        for tool in tools.iter_mut() {
            let Some(row) = tool.as_object_mut() else {
                continue;
            };
            if row.get("type").and_then(Value::as_str) != Some("tool_search") {
                continue;
            }
            let mut function = Map::new();
            function.insert("type".to_string(), Value::String("function".to_string()));
            function.insert("name".to_string(), Value::String("tool_search".to_string()));
            if let Some(description) = row.get("description") {
                function.insert("description".to_string(), description.clone());
            }
            if let Some(parameters) = row.get("parameters") {
                function.insert("parameters".to_string(), parameters.clone());
            }
            *tool = Value::Object(function);
            projected_tool_search = true;
        }
    }
    if projected_tool_search {
        // A hosted `tool_search` choice must follow the projected function name,
        // otherwise the provider rejects an unknown tool_choice variant.
        if let Some(choice) = root.get_mut("tool_choice") {
            if choice.get("type").and_then(Value::as_str) == Some("tool_search") {
                *choice = serde_json::json!({"type": "function", "name": "tool_search"});
            }
        }
    }
    Ok(payload)
}
