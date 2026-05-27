use serde_json::{json, Map, Value};

pub(crate) fn ensure_apply_patch_chat_process_contract(
    request: &mut Map<String, Value>,
    metadata: &Value,
) {
    if !is_apply_patch_servertool_mode(metadata) {
        return;
    }
    let Some(tools) = request.get_mut("tools").and_then(|v| v.as_array_mut()) else {
        return;
    };

    for tool in tools.iter_mut() {
        let Some(tool_obj) = tool.as_object_mut() else {
            continue;
        };
        let function_obj = if tool_obj
            .get("type")
            .and_then(|v| v.as_str())
            .map(|v| v == "function")
            .unwrap_or(false)
        {
            if let Some(function) = tool_obj.get_mut("function").and_then(|v| v.as_object_mut()) {
                Some(function)
            } else {
                Some(tool_obj)
            }
        } else {
            None
        };
        let Some(function_obj) = function_obj else {
            continue;
        };
        let name = function_obj
            .get("name")
            .and_then(|v| v.as_str())
            .map(|v| v.trim().to_ascii_lowercase())
            .unwrap_or_default();
        if name != "apply_patch" {
            continue;
        }

        let parameters_value = function_obj
            .entry("parameters".to_string())
            .or_insert_with(|| Value::Object(Map::new()));
        if !parameters_value.is_object() {
            *parameters_value = Value::Object(Map::new());
        }
        let Some(parameters) = parameters_value.as_object_mut() else {
            continue;
        };
        let properties_value = parameters
            .entry("properties".to_string())
            .or_insert_with(|| Value::Object(Map::new()));
        if !properties_value.is_object() {
            *properties_value = Value::Object(Map::new());
        }
        let Some(properties) = properties_value.as_object_mut() else {
            continue;
        };

        properties.clear();
        properties.insert(
            "filePath".to_string(),
            json!({
                "type": "string",
                "description": "Optional. Workspace-relative target path, for example `src/main.ts` or `tmp/example.txt`. If omitted, the runtime will try to resolve path from patch headers (for example `*** Add File: ...` or unified diff `---/+++`)."
            }),
        );
        properties.insert(
            "patch".to_string(),
            json!({
                "type": "string",
                "description": "Required. Patch payload. Supported formats: line-edit operations (`+ line` / `- line`), unified diff (`---` / `+++`), or Markdown fenced code block (for example ```diff ... ```)."
            }),
        );

        parameters.insert(
            "required".to_string(),
            Value::Array(vec![Value::String("patch".to_string())]),
        );
        parameters.insert("type".to_string(), Value::String("object".to_string()));
        parameters.insert("additionalProperties".to_string(), Value::Bool(true));
        function_obj.insert("strict".to_string(), Value::Bool(false));
        function_obj.insert(
            "description".to_string(),
            Value::String(
                r#"Call apply_patch directly for file edits. `patch` is required; `filePath` is optional. You may provide line-edit patch (`+ line` / `- line`), unified diff (`--- a/...` / `+++ b/...`), or fenced diff block (```diff ... ```). If `filePath` is omitted, path can be inferred from patch headers such as `*** Add File:` or unified diff headers."#.to_string(),
            ),
        );
    }
}

fn resolve_apply_patch_mode(metadata: &Value) -> String {
    let mode = metadata
        .as_object()
        .and_then(|row| row.get("__rt"))
        .and_then(|v| v.as_object())
        .and_then(|rt| rt.get("applyPatch"))
        .and_then(|v| v.as_object())
        .and_then(|ap| ap.get("mode"))
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "client".to_string());
    if mode == "servertool" {
        "servertool".to_string()
    } else {
        "client".to_string()
    }
}

fn is_apply_patch_servertool_mode(metadata: &Value) -> bool {
    resolve_apply_patch_mode(metadata) == "servertool"
}
